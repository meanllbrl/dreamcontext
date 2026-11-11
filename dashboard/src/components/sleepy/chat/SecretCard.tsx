import { useCallback, useMemo, useState } from 'react';
import { useApi } from '../../../context/VaultContext';
import { OWNER_ONLY_LINE, cardFolderText, useHostCard, type CardHost } from '../../../lib/cardRecords';
import { RequestError } from '../../../api/client';
import { useOwnerCardT } from '../../../context/I18nContext';
import { isMacPhoneSurface } from '../../../lib/phoneSurface';
import { MaskedSecretInput } from '../../core/MaskedSecretInput';
import { CardHeader } from './molecules';
import type { SecretViewSpec } from '../../../lib/chatViewSpec';

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

export function SecretCard({ spec, report, sessionId: chatSid, host, folder, reentry = false, onSaved }: {
  spec: SecretViewSpec;
  /** Where the receipt goes: the chat's session, or an agent thread's reply. */
  report?: (text: string) => void;
  /** A chat's card names the server's record (plan H1, H9): the server writes exactly the file
   *  and keys the agent declared, and the hands-free phone may fill it only through it. */
  sessionId?: string;
  /** An owner item's record (the Super-chat slot, K7): found by its handle. Wins over `sessionId`.
   *  Its receipt is the SERVER's to deliver (K6): nothing is posted from here. */
  host?: CardHost;
  /** The folder its `.env` is written in (the card's working root, K5). */
  folder?: { name: string; path: string } | null;
  /** The record is closed but its result is owed and not checked (K1's one re-entry): the form
   *  is offered once more, "you will type it again". */
  reentry?: boolean;
  /** Saved (the slot reads its state again). */
  onSaved?: () => void;
}) {
  const api = useApi();
  const t = useOwnerCardT();
  const fetchJson = useCallback((path: string) => api.get<unknown>(path), [api]);
  const chatHost: CardHost | undefined = host ?? (chatSid ? { session: chatSid } : undefined);
  const { loaded, record, sessionId } = useHostCard(chatHost, spec, fetchJson);
  const recordHost = !!host && 'record' in host;
  const phone = isMacPhoneSurface();
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
      // Every path is the owner's own press (K4): the owner key rides with it.
      const res = await api.ownerPost<SecretResponse>('/agent/secret', {
        ...(sessionId && record ? { sessionId, cardRef: record.cardRef } : {}),
        file: spec.file,
        title: spec.title,
        ...(spec.app ? { app: spec.app } : {}),
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
      // A record host's receipt is held and delivered by the server; a chat's goes as before.
      if (res.receipt && !recordHost) report?.(res.receipt);
      onSaved?.();
    } catch (err) {
      setError(err instanceof RequestError && err.status === 403
        ? (err.message && !/^Request failed/.test(err.message) ? err.message : OWNER_ONLY_LINE)
        : err instanceof Error ? err.message : 'The secret could not be written.');
      setPhase('failed');
    }
  }, [api, filled, phase, record, report, sessionId, spec.app, spec.fields, spec.file, spec.title, values, recordHost, onSaved]);

  if (phase === 'saved' && result) {
    return (
      <div className="chat-viewcard chat-secretcard" data-phase="saved" data-view-kind="secret" data-view-id={spec.id}>
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

  // A chat's card: no record yet (loading), none at all (an old card), or closed. The phone can
  // fill ONLY a live record; the Mac keeps the old path for a card without one. A closed card says
  // "saved" ONLY when its own receipt closed it: one the agent replaced or withdrew wrote nothing.
  const closed = !!sessionId && record?.state === 'closed' && !reentry;
  const unfillable = !!sessionId && (!loaded || (phone && !record));
  if (closed) {
    const saved = record?.closedBy === 'done';
    const note = saved
      ? <>Already saved to <code>{spec.file}</code>. The agent was told the key, not the value.</>
      : record?.closedBy === 'superseded'
        ? <>Nothing was saved here. The agent posted a newer copy of this card further down.</>
        : record?.closedBy === 'dropped'
          ? <>Nothing was saved here. The agent no longer needs this key.</>
          : <>Closed in the chat. Check <code>{spec.file}</code> before you rely on this key.</>;
    return (
      <div className="chat-viewcard chat-secretcard" data-phase={saved ? 'saved' : 'closed'} data-closed-by={record?.closedBy} data-view-kind="secret" data-view-id={spec.id}>
        <CardHeader glyph={saved ? '✓' : '🔑'} title={spec.title} aside={<span className="chat-secretcard-file">{spec.file}</span>} />
        <p className="chat-secretcard-note">{note}</p>
      </div>
    );
  }

  return (
    <div className="chat-viewcard chat-secretcard" data-phase={phase} data-view-kind="secret" data-view-id={spec.id}>
      <CardHeader glyph="🔑" title={spec.title} aside={<span className="chat-secretcard-file" data-testid="secret-card-folder" title={folder?.path}>{spec.app ? `${spec.app} · ${spec.file}` : cardFolderText(folder, spec) ? `${cardFolderText(folder, spec)} · ${spec.file}` : spec.file}</span>} />
      {spec.intro && <p className="chat-secretcard-intro">{spec.intro}</p>}
      {reentry && <p className="chat-secretcard-note" data-testid="secret-card-reentry">{t('ownerCard.secretAgain')}</p>}

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
              disabled={phase === 'saving' || unfillable}
            />
            {f.hint && <p className="chat-secretcard-hint">{f.hint}</p>}
          </div>
        ))}
      </div>

      {error && <p className="chat-secretcard-error">{error}</p>}
      {sessionId && loaded && phone && !record && (
        <p className="chat-secretcard-note">This card is older than the chat's newest cards; fill it on the Mac.</p>
      )}

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
          disabled={!filled || phase === 'saving' || unfillable}
        >
          {phase === 'saving' ? 'Saving…' : spec.submitLabel ?? `Save to ${spec.file}`}
        </button>
      </div>
    </div>
  );
}
