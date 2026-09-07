import { useCallback, useEffect, useState } from 'react';
import { SettingGroup, SettingRow, Toggle } from './SettingRow';
import { isDesktop } from '../../lib/desktop';

/**
 * The Voice card — J.A.R.V.I.S mode's one key and its three preferences.
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
  correction: boolean;
  desktop: boolean;
}

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

export function VoiceSettings() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/agent/voice/status');
      if (!res.ok) return;
      setStatus(await res.json() as VoiceStatus);
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
      if (!res.ok) { setError('Could not save the voice settings.'); return; }
      setStatus(await res.json() as VoiceStatus);
    } catch {
      setError('Could not save the voice settings.');
    } finally {
      setSaving(false);
    }
  }, []);

  if (!status) return null;

  return (
    <SettingGroup
      title="Voice"
      note={
        isDesktop()
          ? 'J.A.R.V.I.S mode: hold the microphone in the chat composer, speak, and hear the answer. Everything runs through OpenRouter on one key.'
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
        title="Speech language"
        hint="Leave it on automatic unless it keeps mishearing which language you are in."
        more={'Automatic sends no language hint and lets the model decide. It is deliberately the default AND deliberately not assumed to work: auto-detection on short takes has never been measured on this code path, and pinning a language here is the fix if it misfires — no code change needed.'}
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
