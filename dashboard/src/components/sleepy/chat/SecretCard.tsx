import { useCallback, useMemo, useState } from 'react';
import { useApi } from '../../../context/VaultContext';
import { MaskedSecretInput } from '../../core/MaskedSecretInput';
import { CardHeader } from './molecules';
import type { SecretViewSpec } from '../../../lib/chatViewSpec';
import type { ChatSession } from '../chatSession';
import { postToSession } from './postToSession';

/**
 * ORGANISM — the `dream-view` SECRET card. A masked field in the transcript whose value
 * goes to a `.env` file and is never seen by the agent.
 *
 * THE ONE INVARIANT: the value's only exit from this component is the POST to
 * `/api/agent/secret`. It is held in local state, cleared the moment the write succeeds,
 * and never reaches `session.send` — what the session receives is the server's RECEIPT
 * (key, file, char count, sha256 prefix), built by the server so the client cannot
 * accidentally interpolate the wrong string. Anything added here that puts `values` into a
 * message, a log, a URL, a title attribute or an analytics call breaks the only promise
 * this card makes, and the promise is printed on the card where the user can read it.
 *
 * Why the receipt is posted as a normal user turn rather than being shown only on screen:
 * the agent is mid-task and waiting for this. Posting it (steering into the running turn
 * when there is one — see `postToSession`) is what lets the work continue without the user
 * typing "ok, done" into the composer, which is the hop this whole feature exists to
 * remove.
 */

interface WrittenRow {
  key: string;
  chars: number;
  fingerprint: string;
  action: 'added' | 'updated';
  duplicate?: true;
}

interface SecretResponse {
  file: string;
  written: WrittenRow[];
  gitignoreAdded?: string;
  /** Built by the server; the client posts it verbatim. */
  receipt?: string;
}

type Phase = 'idle' | 'saving' | 'saved' | 'failed';

export function SecretCard({ spec, session }: { spec: SecretViewSpec; session?: ChatSession }) {
  const api = useApi();
  const [values, setValues] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [result, setResult] = useState<SecretResponse | null>(null);

  const filled = useMemo(
    () => spec.fields.every((f) => (values[f.key] ?? '').trim().length > 0),
    [spec.fields, values],
  );

  const submit = useCallback(async () => {
    if (!filled || phase === 'saving' || phase === 'saved') return;
    setPhase('saving');
    setError('');
    try {
      const res = await api.post<SecretResponse>('/agent/secret', {
        file: spec.file,
        title: spec.title,
        entries: spec.fields.map((f) => ({ key: f.key, value: (values[f.key] ?? '').trim() })),
      });
      // Cleared before anything else can run: from here on the value exists only in the
      // file. A React state update is not a secure erase (the string stays in the heap
      // until GC), and pretending otherwise would be the dishonest comment — but leaving
      // it bound to a mounted input for the rest of the session would be a visible,
      // re-readable copy on screen, and that part we can and do fix.
      setValues({});
      setResult(res);
      setPhase('saved');
      if (session && res.receipt) postToSession(session, res.receipt);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The secret could not be written.');
      setPhase('failed');
    }
  }, [api, filled, phase, session, spec.fields, spec.file, spec.title, values]);

  if (phase === 'saved' && result) {
    return (
      <div className="chat-viewcard chat-secretcard" data-phase="saved">
        <CardHeader glyph="✓" title={spec.title} aside={<span className="chat-secretcard-file">{result.file}</span>} />
        <ul className="chat-secretcard-receipt">
          {result.written.map((w) => (
            <li key={w.key}>
              <code>{w.key}</code> {w.action} · {w.chars} chars · <span className="chat-secretcard-fp">sha256:{w.fingerprint}</span>
              {w.duplicate && <> · the file had this key twice; the last one was rewritten</>}
            </li>
          ))}
          {result.gitignoreAdded && <li>{result.gitignoreAdded} added to .gitignore</li>}
        </ul>
        <p className="chat-secretcard-note">
          Written to <code>{result.file}</code> (0600). The agent was told the key and the fingerprint, not the value.
        </p>
      </div>
    );
  }

  return (
    <div className="chat-viewcard chat-secretcard" data-phase={phase}>
      <CardHeader glyph="🔑" title={spec.title} aside={<span className="chat-secretcard-file">{spec.file}</span>} />
      {spec.intro && <p className="chat-secretcard-intro">{spec.intro}</p>}

      <div className="chat-secretcard-fields">
        {spec.fields.map((f) => (
          <div className="chat-secretcard-field" key={f.key}>
            <label className="chat-secretcard-label" htmlFor={`secret-${spec.id}-${f.key}`}>
              {f.label ?? f.key}
              {f.label && <code className="chat-secretcard-key">{f.key}</code>}
            </label>
            <MaskedSecretInput
              id={`secret-${spec.id}-${f.key}`}
              value={values[f.key] ?? ''}
              onChange={(v) => setValues((prev) => ({ ...prev, [f.key]: v }))}
              onSubmit={spec.fields.length === 1 ? () => { void submit(); } : undefined}
              ariaLabel={f.label ?? f.key}
              disabled={phase === 'saving'}
            />
            {f.hint && <p className="chat-secretcard-hint">{f.hint}</p>}
          </div>
        ))}
      </div>

      {error && <p className="chat-secretcard-error">{error}</p>}

      <div className="chat-secretcard-foot">
        {/* THE STANDING PROMISE. It is not a reassurance, it is the difference between this
            card and the checklist's secret field — and it stays visible while the value is
            being typed, which is when it matters. */}
        <p className="chat-secretcard-note">
          Saved straight to <code>{spec.file}</code> by the app. Not sent to the agent, not in this chat.
        </p>
        <button
          type="button"
          className="chat-btn pill primary"
          onClick={() => { void submit(); }}
          disabled={!filled || phase === 'saving'}
        >
          {phase === 'saving' ? 'Saving…' : spec.submitLabel ?? `Save to ${spec.file}`}
        </button>
      </div>
    </div>
  );
}
