import { useAgentThread, type FeedMessage, type ThreadEntry } from '../../hooks/useAutomations';
import { AgentMessage } from './AgentMessage';

/**
 * ONE RUN'S THREAD, on the right. READ ONLY in this step.
 *
 * The panel shows what the feed deliberately leaves out: the run's own
 * bookkeeping. `started`, `ok`, `failed`, `asked` are grey one-line rows here
 * and appear nowhere else — in the feed they would be four rows of noise per
 * run, and the feed's job is to be readable at a glance.
 *
 * Entries are listed in ID order, never by `at`: two machines' clocks disagree
 * and the id is what survives that.
 *
 * THE COMPOSER IS DISABLED, and says why in its own words. A composer that
 * accepts text and drops it is the one thing this panel must not be, and an
 * absent composer would leave the reader wondering whether replying exists at
 * all — so it is present, inert, and honest about when it starts working.
 */

function hhmm(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A system row's own words, already written by the runner. The panel adds the
 *  time and nothing else — re-phrasing them here would put the same event in
 *  two vocabularies, one of which would go stale. */
function SystemRow({ entry }: { entry: ThreadEntry }) {
  return (
    <div className="agent-thread-sys">
      <span className="agent-thread-sys-time">{hhmm(entry.at)}</span>
      <span className="agent-thread-sys-text">{entry.text}</span>
    </div>
  );
}

function AuthoredRow({ entry, title }: { entry: ThreadEntry; title: string }) {
  return (
    <div className={`agent-thread-post agent-thread-post--${entry.kind}`}>
      <div className="agent-thread-post-head">
        <span className="agent-thread-post-who">{entry.kind === 'user' ? 'You' : title}</span>
        <span className="agent-thread-post-time">{hhmm(entry.at)}</span>
      </div>
      <p className="agent-thread-post-text">{entry.text}</p>
      {entry.files && entry.files.length > 0 && (
        <div className="agent-thread-post-files">
          {entry.files.map((f) => (
            <span key={f} className="agent-thread-post-file" title={f}>
              {f.split('/').pop()}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentThreadPanel({
  message,
  onClose,
  onOpenFile,
  onOpenAgent,
}: {
  message: FeedMessage;
  onClose: () => void;
  onOpenFile: (path: string) => void;
  onOpenAgent: (slug: string) => void;
}) {
  const { data, isLoading } = useAgentThread(message.slug, message.runId);
  const entries = data?.entries ?? [];

  return (
    <aside className="agent-thread" aria-label={`Thread — ${message.title}`}>
      <header className="agent-thread-head">
        <span className="agent-thread-title">Thread</span>
        <span className="agent-thread-sub">{message.title}</span>
        <button type="button" className="agent-thread-close" onClick={onClose} aria-label="Close thread">
          ✕
        </button>
      </header>

      <div className="agent-thread-body">
        {/* The root: the same message, rendered by the same component, without
            its header — the panel's own header already says whose it is. */}
        <AgentMessage
          message={message}
          showHead={false}
          onOpenThread={() => {}}
          onOpenFile={onOpenFile}
          onOpenAgent={onOpenAgent}
        />

        <div className="agent-thread-divider">
          <span>{entries.length} {entries.length === 1 ? 'entry' : 'entries'} in this run</span>
        </div>

        {isLoading && entries.length === 0 && <p className="agent-thread-empty">Reading the thread…</p>}
        {!isLoading && entries.length === 0 && (
          <p className="agent-thread-empty">This run left nothing in its thread.</p>
        )}

        {entries.map((e) =>
          e.kind === 'system'
            ? <SystemRow key={e.id} entry={e} />
            : <AuthoredRow key={e.id} entry={e} title={message.title} />,
        )}
      </div>

      <footer className="agent-thread-foot">
        <div className="agent-thread-composer" aria-disabled="true">
          <textarea
            className="agent-thread-input"
            rows={1}
            disabled
            placeholder="Reply to this run…"
          />
        </div>
        {/* K5: one sentence, and it answers the question the disabled field
            raises rather than restating that it is disabled. */}
        <p className="agent-thread-note">Replies arrive in step 4 — for now this thread is read only.</p>
      </footer>
    </aside>
  );
}
