import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';
import { resolveChatKitTokens } from '../components/sleepy/chat/chatHtmlKit';
import { HtmlView } from '../components/sleepy/chat/HtmlView';
import { artifactReportToHtml, type ReportBlock } from '../lib/artifactReport';
import { downloadBlob, exportFilename, printStandalone } from '../components/sleepy/chat/htmlExport';
import './SavedBlocksPage.css';

/**
 * Saved blocks — the list the feature request drew as "Kayıtlı görseller", plus the compose
 * surface that turns a few of them into one report.
 *
 * WHAT THIS PAGE IS FOR, in the owner's words: "İyi bir tablo ya da şema konuşmanın içinde
 * kalıyor; üç hafta sonra aramak için transcript kaydırmak gerekiyor." So the two things it
 * must do are BE A LIST (name, where it came from, when — openable) and BE COMPOSABLE
 * (several blocks + prose out as one document). Everything else is restraint.
 *
 * The preview reuses `HtmlView` rather than rendering the markup itself. That is not
 * laziness — it is the only correct choice: a saved block is agent-authored markup, and the
 * sandbox is what makes drawing it safe. Rendering it into this page's own DOM would run
 * that markup at app origin.
 */

interface ArtifactMeta {
  slug: string;
  title: string;
  created: string;
  sourceTitle: string | null;
  sourceSession: string | null;
  tags: string[];
}

interface Artifact extends ArtifactMeta { html: string; text: string }

function useArtifacts() {
  const api = useApi();
  return useQuery({
    queryKey: ['artifacts'],
    queryFn: () => api.get<{ artifacts: ArtifactMeta[] }>('/artifacts'),
  });
}

export function SavedBlocksPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const { data, isLoading } = useArtifacts();
  const artifacts = data?.artifacts ?? [];

  const [openSlug, setOpenSlug] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [composing, setComposing] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [reportTitle, setReportTitle] = useState('');
  const [intro, setIntro] = useState('');
  const [prose, setProse] = useState<Record<string, string>>({});
  const [note, setNote] = useState<string | null>(null);

  const open = useQuery({
    queryKey: ['artifacts', openSlug],
    queryFn: () => api.get<Artifact>(`/artifacts/${openSlug}`),
    enabled: openSlug !== null,
  });

  const remove = useMutation({
    mutationFn: (slug: string) => api.del(`/artifacts/${slug}`),
    onSuccess: (_r, slug) => {
      if (openSlug === slug) setOpenSlug(null);
      setPicked((p) => p.filter((s) => s !== slug));
      queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    },
  });

  const shown = useMemo(() => {
    const q = query.trim().toLocaleLowerCase('tr');
    if (!q) return artifacts;
    return artifacts.filter((a) =>
      a.title.toLocaleLowerCase('tr').includes(q)
      || (a.sourceTitle ?? '').toLocaleLowerCase('tr').includes(q));
  }, [artifacts, query]);

  /**
   * Build the composed report. Fetches each picked block's markup on demand — the list
   * endpoint deliberately carries metadata only, so this is where the bytes arrive.
   */
  const buildReport = async (): Promise<string> => {
    const blocks: ReportBlock[] = [];
    for (const slug of picked) {
      const full = await api.get<Artifact>(`/artifacts/${slug}`);
      blocks.push({
        title: full.title,
        html: full.html,
        prose: prose[slug],
        source: full.sourceTitle,
        date: full.created,
      });
    }
    return artifactReportToHtml({
      title: reportTitle.trim() || 'Report',
      intro: intro.trim() || undefined,
      blocks,
      tokens: resolveChatKitTokens(),
      scheme: document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
    });
  };

  const exportReport = async () => {
    setNote(null);
    try {
      const doc = await buildReport();
      downloadBlob(new Blob([doc], { type: 'text/html' }),
        exportFilename(reportTitle || 'report', 'html'));
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Export failed.');
    }
  };

  const printReport = async () => {
    setNote(null);
    try {
      await printStandalone(await buildReport());
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Print failed.');
    }
  };

  const toggle = (slug: string) =>
    setPicked((p) => (p.includes(slug) ? p.filter((s) => s !== slug) : [...p, slug]));

  return (
    <div className="saved-page">
      <header className="saved-head">
        <h1 className="saved-title">Saved blocks</h1>
        <span className="saved-spacer" />
        {artifacts.length > 0 && (
          <input
            className="saved-search"
            value={query}
            placeholder="Filter…"
            aria-label="Filter saved blocks"
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        <button
          className="saved-action"
          onClick={() => { setComposing(!composing); setNote(null); }}
          aria-pressed={composing}
        >
          {composing ? 'Done composing' : 'Compose a report'}
        </button>
      </header>

      {isLoading && <p className="saved-empty">Loading…</p>}

      {!isLoading && artifacts.length === 0 && (
        // The honest empty state names the ACTION that fills it. "No saved blocks" alone
        // would leave the reader with no idea this list is fed from the chat.
        <p className="saved-empty">
          Nothing saved yet. Open a drawn answer in the chat full screen and press
          {' '}<strong>☆ Save</strong> to keep it here.
        </p>
      )}

      {composing && (
        <section className="saved-compose">
          <input
            className="saved-compose-title"
            value={reportTitle}
            placeholder="Report title"
            aria-label="Report title"
            onChange={(e) => setReportTitle(e.target.value)}
          />
          <textarea
            className="saved-compose-intro"
            value={intro}
            rows={2}
            placeholder="An opening line (optional)"
            aria-label="Report introduction"
            onChange={(e) => setIntro(e.target.value)}
          />
          <div className="saved-compose-foot">
            <span className="saved-compose-count">
              {picked.length === 0 ? 'Tick the blocks to include' : `${picked.length} block(s)`}
            </span>
            {note && <span className="saved-note" role="status">{note}</span>}
            <button className="saved-action" onClick={exportReport} disabled={picked.length === 0}>
              Export HTML
            </button>
            <button className="saved-action" onClick={printReport} disabled={picked.length === 0}>
              Print / PDF
            </button>
          </div>
        </section>
      )}

      <ul className="saved-list">
        {shown.map((a) => (
          <li key={a.slug} className="saved-row">
            {composing && (
              <input
                type="checkbox"
                className="saved-pick"
                checked={picked.includes(a.slug)}
                onChange={() => toggle(a.slug)}
                aria-label={`Include ${a.title}`}
              />
            )}
            <button
              className="saved-open"
              onClick={() => setOpenSlug(openSlug === a.slug ? null : a.slug)}
              aria-expanded={openSlug === a.slug}
            >
              <span className="saved-row-title">{a.title}</span>
              <span className="saved-row-meta">
                {a.sourceTitle ?? 'unknown conversation'} · {a.created}
              </span>
            </button>
            <button
              className="saved-del"
              onClick={() => remove.mutate(a.slug)}
              title={`Delete ${a.title}`}
              aria-label={`Delete ${a.title}`}
            >
              ✕
            </button>

            {openSlug === a.slug && (
              <div className="saved-preview">
                {open.isLoading && <p className="saved-empty">Opening…</p>}
                {open.data && <HtmlView html={open.data.html} />}
              </div>
            )}

            {composing && picked.includes(a.slug) && (
              <textarea
                className="saved-prose"
                rows={2}
                value={prose[a.slug] ?? ''}
                placeholder="A note above this block in the report (optional)"
                aria-label={`Note for ${a.title}`}
                onChange={(e) => setProse((p) => ({ ...p, [a.slug]: e.target.value }))}
              />
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
