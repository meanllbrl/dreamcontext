import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { SettingGroup, SettingRow, Toggle } from './SettingRow';
import { isDesktop } from '../../lib/desktop';
import { chordFromEvent, formatHotkey, hotkeyLabel, isLatchKey, parseHotkey } from '../../lib/voice/hotkey';
import { adoptVoicePrefs } from '../../lib/voice/voicePrefs';

/**
 * The Voice card — J.A.R.V.I.S mode's one key, its push-to-talk chord, and the preferences
 * that decide how it listens and how it answers.
 *
 * MACHINE group, not a project one, because that is where the key belongs: it is the owner's
 * OpenRouter key, stored in `~/.dreamcontext/voice.json` at 0600, and putting it in a vault
 * would sync it into a teammate's brain the first time anyone ran a team sync.
 *
 * THE KEY IS WRITE-ONLY FROM HERE. The server reports `key: boolean` and nothing else — there
 * is no route by which the value travels back — so this card can say "a key is set" and offer
 * to replace or clear it, and can never show it. That is not an inconvenience to work around;
 * it is the property that makes the whole feature safe to leave configured.
 *
 * Modelled on the existing embeddings/Hybrid card's shape, which is why it is cheap.
 */

interface VoiceStatus {
  key: boolean;
  voice: string;
  sttLanguage: string;
  sttEngine: 'auto' | 'local' | 'cloud';
  groq: boolean;
  /** The local model this machine was found to have, or null. */
  localWhisper: string | null;
  correction: boolean;
  pushToTalk: string;
  pushToTalkMode: 'hold' | 'toggle';
  speech: boolean;
  speechRate: number;
  musicPause: boolean;
  musicDuck: number;
  /** Whether the SERVER's platform can control the machine's audio at all. The dashboard
   *  cannot infer this — the AppleScript runs server-side — so it is reported. */
  musicControl: boolean;
  desktop: boolean;
}

/** Duck depths, as the owner thinks of them rather than as the code stores them. `1` is the
 *  off switch: one number instead of a number plus a toggle that can contradict it. */
const DUCKS = [
  { value: 1, label: 'Leave it alone' },
  { value: 0.5, label: 'Half' },
  { value: 0.35, label: 'Quiet (default)' },
  { value: 0.2, label: 'Very quiet' },
] as const;

/** The voices the speech endpoint offers. The JARVIS character does NOT come from this list —
 *  there is no British male voice — it comes from the `instructions` parameter the route
 *  sends. This picks the timbre the character is spoken in. */
const VOICES = ['onyx', 'ash', 'echo', 'alloy', 'fable', 'nova', 'shimmer'] as const;

/** `auto` sends no `language` at all. The rest exist because auto-detect on SHORT takes is
 *  UNPROVEN on this code path — the only benchmark ever run used an explicit `-l tr` against
 *  local whisper, which is a different engine entirely. If it misfires, pinning one here is
 *  the documented fix, and it needs no code change. */
const LANGUAGES = [
  { id: 'auto', label: 'Detect automatically' },
  { id: 'tr', label: 'Turkish' },
  { id: 'en', label: 'English' },
] as const;

/** The speeds offered. A short list rather than a slider: the useful range is narrow — the
 *  character stops being calm and precise past it — and a slider would invite the settings
 *  where it does. */
const RATES = [
  { value: 0.9, label: 'Slower (0.9x)' },
  { value: 1, label: 'Normal' },
  { value: 1.15, label: 'Brisk (1.15x)' },
  { value: 1.35, label: 'Fast (1.35x)' },
  { value: 1.6, label: 'Very fast (1.6x)' },
] as const;

export function VoiceSettings() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [groqDraft, setGroqDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  /** True while the hotkey field is focused and listening for the next chord. */
  const [capturing, setCapturing] = useState(false);
  const [hotkeyHint, setHotkeyHint] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/voice/status');
      if (!res.ok) return;
      const body = await res.json() as VoiceStatus;
      setStatus(body);
      // The chat surface reads its chord and its speech preferences from a shared cache; the
      // card that changes them is the one that has to keep it honest.
      adoptVoicePrefs(body);
    } catch { /* the card simply does not render until it can read the truth */ }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const save = useCallback(async (patch: Record<string, unknown>) => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/agent/voice/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string; message?: string } | null;
        setError(body?.error === 'bad_hotkey'
          ? (body.message || 'That key combination cannot be used for push-to-talk.')
          : 'Could not save the voice settings.');
        return;
      }
      const body = await res.json() as VoiceStatus;
      setStatus(body);
      adoptVoicePrefs(body);
    } catch {
      setError('Could not save the voice settings.');
    } finally {
      setSaving(false);
    }
  }, []);

  /**
   * Record the next chord, from the field itself.
   *
   * SAME GRAMMAR AS THE AGENT HOTKEY FIELD a few rows above: a read-only input that captures
   * while it is focused, Backspace clears. Two fields that do the same job in one section
   * must be operated the same way — a second invention here would be the exact failure the
   * settings regroup was written to end.
   *
   * `preventDefault` on every key, because the chords worth binding are precisely the ones
   * something else already answers. A bare modifier is IGNORED rather than refused: the owner
   * is still assembling, and complaining the moment they touch ⌥ would make a two-key binding
   * impossible to enter.
   */
  const captureHotkey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { setHotkeyHint(''); e.currentTarget.blur(); return; }
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      setHotkeyHint('');
      void save({ pushToTalk: null });
      e.currentTarget.blur();
      return;
    }
    if (['Alt', 'Control', 'Shift', 'Meta'].includes(e.key)) return;   // still assembling
    const chord = chordFromEvent(e.nativeEvent);
    if (!chord) {
      // A bare letter would be swallowed app-wide, including inside the composer the mic is
      // meant to fill — push-to-talk listens at the window, not at a focused field.
      setHotkeyHint('Hold Cmd, Ctrl, Alt or Shift with it — or use a function key.');
      return;
    }
    setHotkeyHint('');
    void save({ pushToTalk: formatHotkey(chord) });
    e.currentTarget.blur();
  }, [save]);

  if (!status) return null;

  /** A latch binding forces toggle — the row below says why rather than offering a choice
   *  that cannot be honoured. */
  const capsLock = isLatchKey(parseHotkey(status.pushToTalk)?.code ?? '');

  return (
    <SettingGroup
      title="Voice — J.A.R.V.I.S mode"
      collapsible
      badge={<span className="settings-beta-badge">BETA</span>}
      note={
        isDesktop()
          ? 'Hold the microphone in the chat composer, speak, and hear the answer. Everything runs through OpenRouter on one key, stored on this machine.'
          : 'Voice is a desktop-app feature — the web dashboard has no microphone path. The key set here is used by the desktop app on this machine.'
      }
    >
      <SettingRow
        title="OpenRouter key"
        hint={status.key
          ? 'A key is set. Paste a new one to replace it, or clear it to turn voice off.'
          : 'Without a key the mode still works as text — it just cannot listen or speak.'}
        more={'One key covers all three calls: transcription, the vocabulary check, and speech. It is stored on THIS MACHINE at ~/.dreamcontext/voice.json with 0600 permissions, never in a project, so a team sync cannot carry it anywhere. The server reports only whether a key exists — there is no route that returns the key itself, which is why this field can never show you the one already set. No OpenAI key is read or requested anywhere in this feature.'}
        control={
          <span className="voice-key-row">
            <input
              className="settings-text-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="OpenRouter key"
              placeholder={status.key ? '••••••••••••' : 'sk-or-…'}
              value={keyDraft}
              disabled={saving}
              onChange={(e) => setKeyDraft(e.target.value)}
            />
            <button
              type="button"
              className="btn btn--secondary"
              disabled={saving || !keyDraft.trim()}
              onClick={() => { void save({ openRouterKey: keyDraft.trim() }).then(() => setKeyDraft('')); }}
            >
              Save
            </button>
            {status.key && (
              <button
                type="button"
                className="btn btn--secondary"
                disabled={saving}
                onClick={() => { void save({ openRouterKey: null }); }}
              >
                Clear
              </button>
            )}
          </span>
        }
        status={status.key ? 'Key set' : 'No key'}
      />

      <SettingRow
        title="Groq key (optional)"
        hint={status.groq
          ? 'Set — transcription goes to Groq first.'
          : 'Free tier. Makes transcription faster and steadier; everything works without it.'}
        more={'Only transcription uses it, and only when the transcriber is set to the API. It exists because the shared route measured between 1.3 and 14.2 seconds for the same take while Groq runs the same model on its own hardware for $0.04 an hour with a free tier this feature will not exhaust. Stored beside the other one at ~/.dreamcontext/voice.json, 0600, never in a project — and like the other one, the server reports only whether it exists.'}
        control={
          <span className="voice-key-row">
            <input
              className="settings-text-input"
              type="password"
              autoComplete="off"
              spellCheck={false}
              aria-label="Groq key"
              placeholder={status.groq ? '••••••••••••' : 'gsk_…'}
              value={groqDraft}
              disabled={saving}
              onChange={(e) => setGroqDraft(e.target.value)}
            />
            <button
              type="button"
              className="btn btn--secondary"
              disabled={saving || !groqDraft.trim()}
              onClick={() => { void save({ groqKey: groqDraft.trim() }).then(() => setGroqDraft('')); }}
            >
              Save
            </button>
            {status.groq && (
              <button
                type="button"
                className="btn btn--secondary"
                disabled={saving}
                onClick={() => { void save({ groqKey: null }); }}
              >
                Clear
              </button>
            )}
          </span>
        }
        status={status.groq ? 'Key set' : undefined}
      />

      <SettingRow
        title="Push-to-talk key"
        hint={capturing
          ? 'Press the key or combination you want. Backspace resets it, Escape cancels.'
          : status.pushToTalkMode === 'toggle'
            ? `Press ${hotkeyLabel(status.pushToTalk)} anywhere in the app to start, and again to send.`
            : `Hold ${hotkeyLabel(status.pushToTalk)} anywhere in the app to speak.`}
        more={'The default is not neutral, which is why this is a setting: ⌥Space is a window-manager binding on some machines and Spotlight’s alternate on others, and a key the system answers first makes the mode look broken with nothing on screen to explain it. Caps Lock and the function keys may be bound ALONE, because they type nothing; anything else needs a modifier, since push-to-talk listens at the window and a bare letter would be swallowed everywhere — including inside the composer it is meant to fill. The binding is stored as the PHYSICAL key rather than the character it types, because on a Mac ⌥+V produces “√”, and a binding recorded by character would stop matching the modifier that defines it.'}
        control={
          <input
            className="settings-text-input voice-hotkey"
            readOnly
            aria-label="Push-to-talk key"
            value={capturing ? 'Press a key…' : hotkeyLabel(status.pushToTalk)}
            disabled={saving}
            onFocus={() => { setCapturing(true); setHotkeyHint(''); }}
            onBlur={() => setCapturing(false)}
            onKeyDown={captureHotkey}
          />
        }
        status={hotkeyHint ? <span className="settings-field-hint">{hotkeyHint}</span> : undefined}
      />

      <SettingRow
        title="How it is pressed"
        hint={capsLock
          ? 'Caps Lock can only start and stop — the light is on for exactly as long as it is recording.'
          : 'Hold it while you speak, or press once to start and again to send.'}
        more={'Hold is the safe one: the microphone cannot be left open, because letting go closes it. Toggle exists because holding a chord through a long sentence is unpleasant — and because a latch key has no other option. macOS reports Caps Lock as ON and OFF rather than as held, so a binding on it is always start-and-stop, and this row says so rather than storing a preference the composer would never honour.'}
        control={
          <select
            className="settings-text-input"
            aria-label="How it is pressed"
            value={status.pushToTalkMode}
            disabled={saving || capsLock}
            onChange={(e) => { void save({ pushToTalkMode: e.target.value }); }}
          >
            <option value="hold">Hold to speak</option>
            <option value="toggle">Press to start, press to send</option>
          </select>
        }
      />

      <SettingRow
        title="Voice"
        hint="The timbre answers are spoken in."
        more={'The J.A.R.V.I.S character does not come from this list — this provider has no British male voice. It comes from a fixed instruction the speech request carries, which is also why no second provider was bought. Because the other speech models sit behind the same endpoint, changing voice later is a model id, not an integration.'}
        control={
          <select
            className="settings-text-input"
            aria-label="Voice"
            value={status.voice}
            disabled={saving}
            onChange={(e) => { void save({ voice: e.target.value }); }}
          >
            {VOICES.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        }
      />

      <SettingRow
        title="Transcriber"
        hint={status.sttEngine === 'cloud'
          ? (status.groq
            ? 'Whisper large-v3-turbo on Groq — the fastest of the three, and it detects the language itself.'
            : 'Whisper large-v3-turbo through OpenRouter. Add a Groq key below to make it faster and steadier.')
          : status.localWhisper
            ? `Running on this machine — whisper.cpp ${status.localWhisper}.`
            : 'No local whisper is installed here, so takes go to the API instead.'}
        more={'All three run the SAME model — whisper-large-v3-turbo, a real speech recogniser that detects the language itself. What differs is where. Measured on one Turkish take: local whisper.cpp answered in 0.85s every time; OpenRouter answered in 1.3s, then 9.2s, then 14.2s, then 1.3s — the model is right but its routing is not something a push-to-talk button can depend on; Groq serves it on its own hardware at about 200x realtime for $0.04 an hour, with a free tier that covers this feature outright. So: local if you have it, Groq if you would rather the laptop stayed idle, OpenRouter as the one that needs no second account.'}
        control={
          <select
            className="settings-text-input"
            aria-label="Transcriber"
            value={status.sttEngine}
            disabled={saving}
            onChange={(e) => { void save({ sttEngine: e.target.value }); }}
          >
            <option value="auto">Automatic — local if installed</option>
            <option value="local">Local whisper.cpp</option>
            <option value="cloud">API (Groq, else OpenRouter)</option>
          </select>
        }
        status={status.sttEngine !== 'cloud' && status.localWhisper
          ? <span className="settings-field-hint">{status.localWhisper}</span>
          : undefined}
      />

      <SettingRow
        title="Speech language"
        hint="Automatic detects it from the first take, then keeps that language for the session."
        more={'Detection is a whole extra pass: measured here at ~1.75s for a take against ~0.88s once the language is known. So the first take detects and the rest of the session reuses what it found, and pinning a language skips even that first one. Pin it if you always speak the same language — the only thing it costs is that a sentence in the other language will be transcribed as though it were this one.'}
        control={
          <select
            className="settings-text-input"
            aria-label="Speech language"
            value={status.sttLanguage}
            disabled={saving}
            onChange={(e) => { void save({ sttLanguage: e.target.value }); }}
          >
            {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        }
      />

      <SettingRow
        title="Speak answers"
        hint="Off keeps push-to-talk and the on-screen structure — it just stops talking back."
        more={'The two halves of the mode are independently useful. Dictation costs a fraction of speech, and there are rooms and calls where an agent reading its answer aloud is the wrong thing entirely. Switching this off mid-answer silences the NEXT sentence rather than the next session, and switching it back on resumes with what is arriving then — it does not replay what it missed.'}
        labelled
        control={
          <Toggle
            label="Speak answers"
            checked={status.speech}
            disabled={saving}
            onChange={(next) => { void save({ speech: next }); }}
          />
        }
      />

      <SettingRow
        title="Speaking speed"
        hint="How fast answers are read back."
        more={'Applied to playback on this machine rather than sent to the speech model, so it costs nothing and cannot be a request that fails. The offered range is deliberately narrow: past it the character stops being the calm, precise one the speech instruction asks for.'}
        control={
          <select
            className="settings-text-input"
            aria-label="Speaking speed"
            value={String(status.speechRate)}
            disabled={saving || !status.speech}
            onChange={(e) => { void save({ speechRate: Number(e.target.value) }); }}
          >
            {/* A rate stored outside the offered list — a clamped value, or one an older
                build wrote — is shown rather than silently rendering an empty select that
                would overwrite it on the next change. */}
            {!RATES.some((r) => r.value === status.speechRate) && (
              <option value={String(status.speechRate)}>{`${status.speechRate}x`}</option>
            )}
            {RATES.map((r) => <option key={r.value} value={String(r.value)}>{r.label}</option>)}
          </select>
        }
      />

      <SettingRow
        title="Pause music while speaking"
        hint="Pauses Spotify for the length of an answer, then puts it back."
        more={'Asked precisely rather than blindly: the player is queried first and paused only if it is actually playing, so a Spotify that is closed is never launched and a track that is already stopped is never "resumed" afterwards. Only a player this app paused is resumed, and only if it is still paused — if you press play yourself during an answer, that is your answer and nothing overrides it. The first answer fires a one-time macOS permission prompt for controlling Spotify; refuse it and this simply does nothing, with the answer still read normally. Apple Music is deliberately not included: adding a player means prompting you about an app you do not use.'}
        labelled
        control={
          <Toggle
            label="Pause music while speaking"
            checked={status.musicPause}
            disabled={saving || !status.musicControl}
            onChange={(next) => { void save({ musicPause: next }); }}
          />
        }
      />

      <SettingRow
        title="Everything else"
        hint="What to do about audio that cannot be paused precisely — a browser tab, typically."
        more={'macOS gives an app one lever over audio it does not own: the system output volume. That lever is indiscriminate — it lowers this app’s voice by exactly as much — so the duck is paired with a compensating boost on the spoken answer, with a limiter behind it. That compensation treats the volume scale as linear in loudness, which is an approximation and the reason the depth is a choice rather than a constant: a deeper duck is one that cannot be fully given back. Used ONLY when no known player was playing, so an answer that paused Spotify never also touches your volume. The volume is restored only if it is still the value this app set.'}
        control={
          <select
            className="settings-text-input"
            aria-label="Duck other audio"
            value={String(status.musicDuck)}
            disabled={saving || !status.musicControl}
            onChange={(e) => { void save({ musicDuck: Number(e.target.value) }); }}
          >
            {!DUCKS.some((d) => d.value === status.musicDuck) && (
              <option value={String(status.musicDuck)}>{`${Math.round(status.musicDuck * 100)}%`}</option>
            )}
            {DUCKS.map((d) => <option key={d.value} value={String(d.value)}>{d.label}</option>)}
          </select>
        }
      />

      <SettingRow
        title="Fix project words"
        hint="Repairs project jargon a transcriber has never heard — “Sırıp” becomes “sleep”."
        more={'Anything it CHANGES waits in the composer with the change marked, for you to send. Only an untouched transcript goes on its own. That is a rule about behaviour rather than a confidence score, because there is no score that separates a legitimate repair from a dangerous one — “start” to “stop” and “Sırıp” to “sleep” are equally close. Turn this off and takes go through exactly as heard.'}
        labelled
        control={
          <Toggle
            label="Fix project words"
            checked={status.correction}
            disabled={saving}
            onChange={(next) => { void save({ correction: next }); }}
          />
        }
      />

      {error && <p className="settings-field-hint">{error}</p>}
    </SettingGroup>
  );
}
