import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
// Arms `==highlight==` on the shared `marked` singleton (lib/markdownMark.ts).
import '../../../lib/markdownMark';
import type { Task } from '../../../hooks/useTasks';
import { useAddTaskChangelog, useInsertTaskSection } from '../../../hooks/useTasks';
import {
  SECTION_HEADINGS, checkItems, latestEntries, missingSections, sectionContent, splitSections,
  type BodySection, type SectionKey,
} from './sectionModel';
import { sanitizeTaskHtml } from './sanitize';
import { useMermaid } from './useMermaid';

marked.setOptions({ gfm: true, breaks: true });

type Theme = 'light' | 'dark';

/** Markdown → sanitized HTML. Every marked output in the drawer goes through here or the criteria list. */
export function toSafeHtml(md: string): string {
  return sanitizeTaskHtml(marked.parse(md) as string);
}

/**
 * One rendered markdown block: sanitized HTML, mermaid blocks drawn as zoomable SVGs, and, for
 * a tickable section (User Stories), its checkboxes wired back to the body by index.
 */
function MarkdownBlock({ md, slug, theme, sectionKey, onToggle, expectedBoxes, className }: {
  md: string;
  slug: string;
  theme: Theme;
  sectionKey: SectionKey;
  onToggle?: (key: SectionKey, index: number, checked: boolean) => void;
  /** How many checkboxes the body model counts in this section. Ticking is wired only when the
   *  rendered boxes match it one for one; otherwise a click could flip the wrong line. */
  expectedBoxes?: number;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const safeHtml = useMemo(() => toSafeHtml(md), [md]);
  // The block's HTML is written HERE, not through dangerouslySetInnerHTML: the mermaid pass
  // replaces code blocks with live SVGs in this DOM, and a React re-render must never put the
  // raw markup back over them. Content changes only when the sanitized HTML does.
  const written = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (ref.current && written.current !== safeHtml) {
      ref.current.innerHTML = safeHtml;
      written.current = safeHtml;
    }
  }, [safeHtml]);
  useMermaid(ref, safeHtml, slug, theme);
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;

  useEffect(() => {
    const root = ref.current;
    if (!root || !toggleRef.current) return;
    const inputs = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    if (expectedBoxes !== undefined && inputs.length !== expectedBoxes) return;
    inputs.forEach((el, i) => { el.removeAttribute('disabled'); el.dataset.criterionIndex = String(i); });
    const onChange = (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox' || target.dataset.criterionIndex === undefined) return;
      toggleRef.current?.(sectionKey, Number(target.dataset.criterionIndex), target.checked);
    };
    root.addEventListener('change', onChange);
    return () => root.removeEventListener('change', onChange);
  }, [safeHtml, sectionKey, expectedBoxes]);

  return <div ref={ref} className={`markdown-body ${className ?? ''}`} />;
}

export function Section({ k, title, count, actions, children }: { k: string; title: string; count?: number | string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="dsec" data-section={k}>
      <div className="dsec-head">
        <h3 className="dsec-title">{title}</h3>
        {count !== undefined && <span className="dsec-count">{count}</span>}
        <span className="dsec-actions">{actions}</span>
      </div>
      {children}
    </section>
  );
}

/** A section that starts folded to a few lines with "Expand" (Technical Details, Notes, a long Why). */
function Folded({ children, label, startOpen = false }: { children: ReactNode; label: string; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <div className="dfold" data-open={open || undefined}>
      <div className="dfold-body">{children}</div>
      <button type="button" className="dsec-action dfold-toggle" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? 'Collapse' : label}
      </button>
    </div>
  );
}

/** Constraints & Decisions / Changelog: the newest 3 entries, "All n" opens the rest. */
function LatestList({ text, kind, slug, theme, actions }: { text: string; kind: 'constraints' | 'changelog'; slug: string; theme: Theme; actions?: ReactNode }) {
  const [all, setAll] = useState(false);
  const { entries, total } = latestEntries(text, all ? Number.MAX_SAFE_INTEGER : 3, kind);
  const title = kind === 'constraints' ? SECTION_HEADINGS.constraints : SECTION_HEADINGS.changelog;
  return (
    <Section
      k={kind}
      title={title}
      count={total}
      actions={<>
        {total > 3 && <button type="button" className="dsec-action" onClick={() => setAll((v) => !v)}>{all ? 'Latest 3' : `All ${total}`}</button>}
        {actions}
      </>}
    >
      {total === 0 ? (
        <MarkdownBlock md={sectionContent(text)} slug={slug} theme={theme} sectionKey={kind} />
      ) : (
        <ul className="dlog-list">
          {entries.map((e, i) => {
            const m = kind === 'changelog'
              ? /^###\s+(\d{4}-\d{2}-\d{2})?\s*-?\s*(.*)\n?([\s\S]*)$/.exec(e)
              : /^[-*+]\s+(?:\*\*\[(\d{4}-\d{2}-\d{2})\]\*\*)?\s*([\s\S]*)$/.exec(e);
            const date = m?.[1] ?? '';
            const rest = kind === 'changelog' ? (m?.[3]?.trim() || m?.[2] || e) : (m?.[2] ?? e);
            return (
              <li key={i} className="dlog-row">
                <span className="dlog-date">{kind === 'changelog' ? date.slice(5) : date}</span>
                <MarkdownBlock md={rest} slug={slug} theme={theme} sectionKey={kind} className="dlog-text" />
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

const INSERTABLE: Record<Exclude<SectionKey, 'other'>, string> = {
  why: 'why', user_stories: 'user_stories', acceptance_criteria: 'acceptance_criteria', workflow: 'workflow',
  constraints: 'constraints', technical_details: 'technical_details', notes: 'notes', changelog: 'changelog',
};

/** "+ Add section": lists only the sections the body lacks; inserts through POST insert. */
function AddSection({ task }: { task: Task }) {
  const insert = useInsertTaskSection();
  // A missing Changelog is started through the changelog route, which creates the heading.
  const addLog = useAddTaskChangelog();
  const [menu, setMenu] = useState(false);
  const [picked, setPicked] = useState<Exclude<SectionKey, 'other'> | null>(null);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const missing = missingSections(task.body ?? '');
  if (missing.length === 0) return null;
  const save = () => {
    if (!picked || !text.trim()) return;
    setError(null);
    const opts = { onSuccess: () => { setPicked(null); setText(''); }, onError: (err: unknown) => setError(err instanceof Error ? err.message : 'Could not add the section.') };
    if (picked === 'changelog') addLog.mutate({ slug: task.slug, content: text.trim() }, opts);
    else insert.mutate({ slug: task.slug, section: INSERTABLE[picked], content: text.trim() }, opts);
  };
  if (picked) {
    return (
      <div className="dadd-form">
        <div className="dadd-form-title">{SECTION_HEADINGS[picked]}</div>
        <textarea className="prop-text-input prop-textarea" rows={4} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Write it in markdown…" />
        <div className="dadd-form-actions">
          <button type="button" className="btn btn--ghost" onClick={() => { setPicked(null); setText(''); setError(null); }}>Cancel</button>
          <button type="button" className="btn btn--primary" onClick={save} disabled={!text.trim() || insert.isPending || addLog.isPending}>Add section</button>
        </div>
        {error && <div className="prop-error" role="alert">{error}</div>}
      </div>
    );
  }
  return (
    <div className="dadd" onKeyDown={(e) => { if (e.key === 'Escape' && menu) { e.preventDefault(); setMenu(false); } }}>
      <button type="button" className="dadd-btn" data-testid="add-section" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>
        + Add section <span className="dadd-hint">· {missing.map((k) => SECTION_HEADINGS[k]).join(', ')}</span>
      </button>
      {menu && (
        <div className="dadd-menu" role="menu">
          {missing.map((k) => (
            <button key={k} type="button" role="menuitem" className="dadd-item" onClick={() => { setMenu(false); setPicked(k); }}>{SECTION_HEADINGS[k]}</button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Changelog "Add entry": works on a task with no `## Changelog` (the route creates it). */
function AddChangelogEntry({ task }: { task: Task }) {
  const add = useAddTaskChangelog();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  if (!open) return <button type="button" className="dsec-action" data-testid="add-changelog" onClick={() => setOpen(true)}>+ Add entry</button>;
  const submit = () => {
    if (!text.trim()) return;
    setError(null);
    add.mutate(
      { slug: task.slug, content: text.trim() },
      { onSuccess: () => { setText(''); setOpen(false); }, onError: (err) => setError(err instanceof Error ? err.message : 'Could not add the entry.') },
    );
  };
  return (
    <span className="dlog-add">
      <input
        className="field-input"
        autoFocus
        value={text}
        placeholder="What changed?"
        aria-label="Changelog entry"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') submit(); else if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }}
      />
      <button type="button" className="btn btn--primary" onClick={submit} disabled={!text.trim() || add.isPending}>Add</button>
      {error && <span className="prop-error" role="alert">{error}</span>}
    </span>
  );
}

/**
 * The task body as sections, in the approved order: Why, Subtasks, Acceptance Criteria, Media,
 * User Stories, Workflow, Constraints & Decisions, Technical Details, Notes, (any other heading),
 * Changelog. A section the file does not have is not shown. Subtasks, criteria and media are
 * slots the shell fills.
 */
export function BodySections({ task, body, theme, slots, onToggle }: {
  task: Task;
  /** The body as the drawer currently sees it (the pending, optimistic one). */
  body: string;
  theme: Theme;
  /** `work`: the agent job's Deliveries and Review rounds (after Media); `history`: who moved
   *  the status (before the Changelog). */
  slots: { subtasks: ReactNode; criteria: ReactNode; media: ReactNode; work?: ReactNode; history?: ReactNode };
  onToggle: (key: SectionKey, index: number, checked: boolean) => void;
}) {
  const sections = useMemo(() => splitSections(body), [body]);
  const pick = (k: SectionKey): BodySection | null => sections.find((s) => s.key === k && sectionContent(s.text)) ?? null;
  const why = pick('why');
  const stories = pick('user_stories');
  const workflow = pick('workflow');
  const constraints = pick('constraints');
  const tech = pick('technical_details');
  const notes = pick('notes');
  const changelog = sections.find((s) => s.key === 'changelog') ?? null;
  const others = sections.filter((s) => s.key === 'other' && sectionContent(s.text));
  const slug = task.slug;

  return (
    <div className="dbody">
      {why && (
        <Section k="why" title="Why">
          {sectionContent(why.text).split('\n').length > 4 || sectionContent(why.text).length > 420
            ? <Folded label="more"><MarkdownBlock md={sectionContent(why.text)} slug={slug} theme={theme} sectionKey="why" /></Folded>
            : <MarkdownBlock md={sectionContent(why.text)} slug={slug} theme={theme} sectionKey="why" />}
        </Section>
      )}
      {slots.subtasks}
      {slots.criteria}
      {slots.media}
      {slots.work}
      {stories && (
        <Section k="user_stories" title="User Stories">
          <MarkdownBlock md={stories.text} slug={slug} theme={theme} sectionKey="user_stories" onToggle={onToggle} expectedBoxes={checkItems(body, 'user_stories').length} />
        </Section>
      )}
      {workflow && (
        <Section k="workflow" title="Workflow">
          <MarkdownBlock md={sectionContent(workflow.text)} slug={slug} theme={theme} sectionKey="workflow" />
        </Section>
      )}
      {constraints && <LatestList text={constraints.text} kind="constraints" slug={slug} theme={theme} />}
      {tech && (
        <Section k="technical_details" title="Technical Details">
          <Folded label="Expand"><MarkdownBlock md={sectionContent(tech.text)} slug={slug} theme={theme} sectionKey="technical_details" /></Folded>
        </Section>
      )}
      {notes && (
        <Section k="notes" title="Notes">
          <Folded label="Expand"><MarkdownBlock md={sectionContent(notes.text)} slug={slug} theme={theme} sectionKey="notes" /></Folded>
        </Section>
      )}
      {others.map((o) => (
        <Section key={`${o.heading}-${o.start}`} k="other" title={o.heading || 'Notes'}>
          <MarkdownBlock md={sectionContent(o.text)} slug={slug} theme={theme} sectionKey="other" />
        </Section>
      ))}
      {slots.history}
      {changelog && sectionContent(changelog.text) && (
        <LatestList text={changelog.text} kind="changelog" slug={slug} theme={theme} actions={<AddChangelogEntry task={task} />} />
      )}
      <AddSection task={task} />
    </div>
  );
}
