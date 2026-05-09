import { useState, useMemo, useRef, useEffect } from 'react';
import { marked } from 'marked';
import mermaid from 'mermaid';
import panzoom from 'panzoom';
import type { Task, RiceFields, RiceInput } from '../../hooks/useTasks';
import { useUpdateTask, useAddTaskChangelog } from '../../hooks/useTasks';
import { usePlanningVersions } from '../../hooks/useVersions';
import { useI18n } from '../../context/I18nContext';
import './TaskDetailPanel.css';

marked.setOptions({ gfm: true, breaks: true });

let mermaidInited = false;
function ensureMermaid() {
  if (mermaidInited) return;
  const isDark =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  mermaid.initialize({
    startOnLoad: false,
    theme: isDark ? 'dark' : 'default',
    securityLevel: 'strict',
    flowchart: {
      htmlLabels: true,
      curve: 'basis',
      nodeSpacing: 40,
      rankSpacing: 60,
    },
  });
  mermaidInited = true;
}

const CLOSE_FOR: Record<string, string> = { '[': ']', '(': ')', '{': '}' };

// Quote unquoted node labels on a single line. Handles labels containing
// brackets, regex chars, etc. by scanning to the LAST matching close bracket
// on the line (mermaid requires labels on one line anyway).
function quoteLabelsInLine(line: string): string {
  // Skip class/classDef/style/link lines and subgraph headers.
  if (/^\s*(classDef|class|style|linkStyle|click|subgraph)\b/.test(line)) return line;

  let out = '';
  let i = 0;
  const n = line.length;

  while (i < n) {
    // Look for `Id[` / `Id(` / `Id{` starting here.
    const m = line.slice(i).match(/^(\s*[A-Za-z_]\w*\s*)([\[\(\{])/);
    if (!m) {
      out += line[i];
      i++;
      continue;
    }
    const idPart = m[1];
    const open = m[2];
    const close = CLOSE_FOR[open];
    const labelStart = i + idPart.length + 1;

    // Find the LAST matching close bracket on the line (handles nested).
    const lastClose = line.lastIndexOf(close);
    if (lastClose <= labelStart) {
      out += line[i];
      i++;
      continue;
    }
    const label = line.slice(labelStart, lastClose);
    const trimmed = label.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      // Already quoted — leave as is.
      out += line.slice(i, lastClose + 1);
      i = lastClose + 1;
      continue;
    }
    if (trimmed === '') {
      out += line.slice(i, lastClose + 1);
      i = lastClose + 1;
      continue;
    }
    const escaped = trimmed
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    out += `${idPart}${open}"${escaped}"${close}`;
    i = lastClose + 1;
  }
  return out;
}

function sanitizeMermaid(src: string): string {
  return src.split('\n').map(quoteLabelsInLine).join('\n');
}

interface TaskDetailPanelProps {
  task: Task;
  onClose: () => void;
  initialRiceExpanded?: boolean;
}

const REACH_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
const IMPACT_OPTIONS = [1, 2, 3, 4, 5] as const;
const VALID_CONFIDENCES = [25, 50, 75, 100] as const;
const EFFORT_OPTIONS = [0.5, 1, 1.5, 2, 3, 4, 5, 6, 8] as const;

function scoreColorClass(score: number | null): string {
  if (score === null || score === undefined) return '';
  if (score < 5) return 'rice-score--low';
  if (score <= 15) return 'rice-score--mid';
  return 'rice-score--high';
}

interface RiceBlockProps {
  task: Task;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (patch: RiceInput | null) => void;
}

function RiceBlock({ task, expanded, onToggle, onUpdate }: RiceBlockProps) {
  const { t } = useI18n();
  const rice: RiceFields | null = task.rice;
  const score = rice?.score ?? null;
  const scoreLabel = score === null ? '—' : String(score);
  const colorClass = scoreColorClass(score);

  const currentValue = (field: keyof RiceInput): number | null => (rice ? rice[field] : null);

  const handlePick = (field: keyof RiceInput, raw: string) => {
    const next = raw === '' ? null : Number(raw);
    if (next !== null && !Number.isFinite(next)) return;
    // No-op guard: skip API call if value didn't change.
    if (next === currentValue(field)) return;
    onUpdate({ [field]: next } as RiceInput);
  };

  return (
    <div className={`rice-block ${expanded ? 'rice-block--open' : ''}`}>
      <button type="button" className="rice-header" onClick={onToggle} aria-expanded={expanded}>
        <span className="rice-header-label">{t('rice.title')}</span>
        <span className={`rice-score-badge ${colorClass}`} title={t('rice.score')}>{scoreLabel}</span>
        <svg className={`rice-chevron ${expanded ? 'rice-chevron--open' : ''}`} width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>
      {expanded && (
        <div className="rice-grid">
          <label className="rice-field">
            <span className="rice-field-label">{t('rice.reach')}</span>
            <select
              className="field-select rice-input"
              value={rice?.reach ?? ''}
              title={t('rice.tooltip.reach')}
              onChange={e => handlePick('reach', e.target.value)}
            >
              <option value="">—</option>
              {REACH_OPTIONS.map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="rice-field">
            <span className="rice-field-label">{t('rice.impact')}</span>
            <select
              className="field-select rice-input"
              value={rice?.impact ?? ''}
              title={t('rice.tooltip.impact')}
              onChange={e => handlePick('impact', e.target.value)}
            >
              <option value="">—</option>
              {IMPACT_OPTIONS.map(v => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>
          <label className="rice-field">
            <span className="rice-field-label">{t('rice.confidence')}</span>
            <select
              className="field-select rice-input"
              value={rice?.confidence ?? ''}
              title={t('rice.tooltip.confidence')}
              onChange={e => handlePick('confidence', e.target.value)}
            >
              <option value="">—</option>
              {VALID_CONFIDENCES.map(v => (
                <option key={v} value={v}>{v}%</option>
              ))}
            </select>
          </label>
          <label className="rice-field">
            <span className="rice-field-label">{t('rice.effort')}</span>
            <select
              className="field-select rice-input"
              value={rice?.effort ?? ''}
              title={t('rice.tooltip.effort')}
              onChange={e => handlePick('effort', e.target.value)}
            >
              <option value="">—</option>
              {EFFORT_OPTIONS.map(v => (
                <option key={v} value={v}>{v}w</option>
              ))}
            </select>
          </label>
          {rice && (
            <button
              type="button"
              className="rice-clear-btn"
              onClick={() => onUpdate(null)}
            >
              {t('rice.clear')}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop-row">
      <span className="prop-label">{label}</span>
      <div className="prop-value">{children}</div>
    </div>
  );
}

function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const [isTruncated, setIsTruncated] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // Check after render with clamped class applied
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) setIsTruncated(el.scrollHeight > el.clientHeight + 1);
    });
  }, [text]);

  return (
    <span className="prop-expandable" onClick={() => setExpanded(v => !v)}>
      <span ref={ref} className={`prop-text ${expanded ? '' : 'prop-text--clamped'}`}>{text}</span>
      {isTruncated && !expanded && <span className="prop-expand-hint">show more</span>}
      {expanded && isTruncated && <span className="prop-expand-hint">show less</span>}
    </span>
  );
}

export function TaskDetailPanel({ task, onClose, initialRiceExpanded }: TaskDetailPanelProps) {
  const { t } = useI18n();
  const updateTask = useUpdateTask();
  const addChangelog = useAddTaskChangelog();
  const { data: versions } = usePlanningVersions();
  const [changelogEntry, setChangelogEntry] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [riceExpanded, setRiceExpanded] = useState(initialRiceExpanded ?? !!task.rice);

  const onMutationError = (err: Error) => {
    setMutationError(err.message);
    setTimeout(() => setMutationError(null), 5000);
  };

  const handleStatusChange = (status: string) => {
    updateTask.mutate(
      { slug: task.slug, updates: { status: status as Task['status'] } },
      { onError: onMutationError },
    );
  };

  const handlePriorityChange = (priority: string) => {
    updateTask.mutate(
      { slug: task.slug, updates: { priority: priority as Task['priority'] } },
      { onError: onMutationError },
    );
  };

  const handleUrgencyChange = (urgency: string) => {
    updateTask.mutate(
      { slug: task.slug, updates: { urgency: urgency as Task['urgency'] } },
      { onError: onMutationError },
    );
  };

  const handleVersionChange = (version: string) => {
    updateTask.mutate(
      { slug: task.slug, updates: { version: version || null } },
      { onError: onMutationError },
    );
  };

  const handleRiceUpdate = (patch: RiceInput | null) => {
    updateTask.mutate(
      { slug: task.slug, updates: { rice: patch } },
      { onError: onMutationError },
    );
  };

  const handleAddChangelog = (e: React.FormEvent) => {
    e.preventDefault();
    if (!changelogEntry.trim()) return;
    addChangelog.mutate(
      { slug: task.slug, content: changelogEntry.trim() },
      { onSuccess: () => setChangelogEntry(''), onError: onMutationError },
    );
  };

  const bodyHtml = useMemo(() => {
    if (!task.body) return '';
    return marked.parse(task.body) as string;
  }, [task.body]);

  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !bodyHtml) return;
    ensureMermaid();

    const blocks = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
    if (blocks.length === 0) return;

    let cancelled = false;
    const disposers: Array<() => void> = [];

    blocks.forEach((code, i) => {
      const pre = code.parentElement!;
      if (pre.dataset.mermaidRendered === '1') return;
      const source = sanitizeMermaid(code.textContent ?? '');
      const id = `mmd-${task.slug}-${i}-${Date.now()}`;

      const wrap = document.createElement('div');
      wrap.className = 'mermaid-rendered';

      const stage = document.createElement('div');
      stage.className = 'mermaid-stage';
      wrap.appendChild(stage);

      const controls = document.createElement('div');
      controls.className = 'mermaid-controls';
      controls.innerHTML = `
        <button type="button" data-act="out" title="Zoom out">−</button>
        <button type="button" data-act="reset" title="Fit">⤢</button>
        <button type="button" data-act="in" title="Zoom in">+</button>
      `;
      wrap.appendChild(controls);

      pre.replaceWith(wrap);

      mermaid
        .render(id, source)
        .then(({ svg, bindFunctions }) => {
          if (cancelled) return;
          stage.innerHTML = svg;
          bindFunctions?.(stage);
          wrap.dataset.mermaidRendered = '1';

          const svgEl = stage.querySelector('svg') as SVGSVGElement | null;
          if (!svgEl) return;
          // Make svg fill the stage so panzoom transforms scale meaningfully.
          svgEl.removeAttribute('height');
          svgEl.style.width = '100%';
          svgEl.style.height = '100%';
          svgEl.style.maxWidth = 'none';

          const pz = panzoom(svgEl, {
            maxZoom: 8,
            minZoom: 0.2,
            bounds: false,
            zoomDoubleClickSpeed: 1.6,
            smoothScroll: false,
          });

          const fit = () => {
            try {
              const stageBox = stage.getBoundingClientRect();
              const bbox = svgEl.getBBox();
              if (bbox.width === 0 || bbox.height === 0) return;
              const padding = 24;
              const scale = Math.min(
                (stageBox.width - padding) / bbox.width,
                (stageBox.height - padding) / bbox.height,
              );
              pz.zoomAbs(0, 0, 1);
              pz.moveTo(0, 0);
              pz.zoomAbs(stageBox.width / 2, stageBox.height / 2, scale);
              const t = pz.getTransform();
              const cx = (stageBox.width - bbox.width * scale) / 2 - bbox.x * scale;
              const cy = (stageBox.height - bbox.height * scale) / 2 - bbox.y * scale;
              pz.moveTo(cx, cy);
              void t;
            } catch {
              /* noop */
            }
          };
          // Fit after layout settles.
          requestAnimationFrame(fit);

          controls.addEventListener('click', (e) => {
            const btn = (e.target as HTMLElement).closest('button');
            if (!btn) return;
            const stageBox = stage.getBoundingClientRect();
            const cx = stageBox.width / 2;
            const cy = stageBox.height / 2;
            const act = btn.getAttribute('data-act');
            if (act === 'in') pz.smoothZoom(cx, cy, 1.4);
            else if (act === 'out') pz.smoothZoom(cx, cy, 1 / 1.4);
            else if (act === 'reset') fit();
          });

          disposers.push(() => pz.dispose());
        })
        .catch((err) => {
          if (cancelled) return;
          stage.innerHTML = `<pre class="mermaid-error">Mermaid render failed: ${String(err?.message ?? err)}</pre>`;
        });
    });

    return () => {
      cancelled = true;
      disposers.forEach((d) => d());
    };
  }, [bodyHtml, task.slug]);

  return (
    <div className="detail-overlay" onClick={onClose}>
      <div className="detail-panel" onClick={e => e.stopPropagation()}>
        <div className="detail-header">
          <h2 className="detail-title">{task.name}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>

        <div className="detail-body">
          {mutationError && (
            <div className="error-state" style={{ marginBottom: 'var(--space-3)' }}>{mutationError}</div>
          )}

          {/* Properties Block */}
          <div className="props-block">
            <PropertyRow label="Status">
              <select
                className="field-select prop-select"
                value={task.status}
                onChange={e => handleStatusChange(e.target.value)}
              >
                <option value="todo">{t('tasks.todo')}</option>
                <option value="in_progress">{t('tasks.in_progress')}</option>
                <option value="in_review">{t('tasks.in_review')}</option>
                <option value="completed">{t('tasks.completed')}</option>
              </select>
            </PropertyRow>

            <PropertyRow label={t('tasks.priority')}>
              <select
                className="field-select prop-select"
                value={task.priority}
                onChange={e => handlePriorityChange(e.target.value)}
              >
                <option value="low">{t('priority.low')}</option>
                <option value="medium">{t('priority.medium')}</option>
                <option value="high">{t('priority.high')}</option>
                <option value="critical">{t('priority.critical')}</option>
              </select>
            </PropertyRow>

            <PropertyRow label="Urgency">
              <select
                className="field-select prop-select"
                value={task.urgency}
                onChange={e => handleUrgencyChange(e.target.value)}
              >
                <option value="low">{t('priority.low')}</option>
                <option value="medium">{t('priority.medium')}</option>
                <option value="high">{t('priority.high')}</option>
                <option value="critical">{t('priority.critical')}</option>
              </select>
            </PropertyRow>

            <PropertyRow label={t('rice.title')}>
              <RiceBlock
                task={task}
                expanded={riceExpanded}
                onToggle={() => setRiceExpanded(v => !v)}
                onUpdate={handleRiceUpdate}
              />
            </PropertyRow>

            {task.tags.length > 0 && (
              <PropertyRow label="Tags">
                <div className="prop-tags">
                  {task.tags.map(tag => (
                    <span key={tag} className="task-tag">{tag}</span>
                  ))}
                </div>
              </PropertyRow>
            )}

            {task.related_feature && (
              <PropertyRow label="Feature">
                <span className="prop-feature">{task.related_feature}</span>
              </PropertyRow>
            )}

            <PropertyRow label="Version">
              <select
                className="field-select prop-select"
                value={task.version ?? ''}
                onChange={e => handleVersionChange(e.target.value)}
              >
                <option value="">No version</option>
                {(versions ?? []).map(v => (
                  <option key={v.version} value={v.version}>{v.version}</option>
                ))}
                {task.version && !(versions ?? []).some(v => v.version === task.version) && (
                  <option value={task.version}>{task.version}</option>
                )}
              </select>
            </PropertyRow>

            {task.description && (
              <PropertyRow label="Description">
                <ExpandableText text={task.description} />
              </PropertyRow>
            )}

            <PropertyRow label="Created">
              <span className="prop-date">{task.created_at}</span>
            </PropertyRow>

            <PropertyRow label="Updated">
              <span className="prop-date">{task.updated_at}</span>
            </PropertyRow>

            {task.parent_task && (
              <PropertyRow label="Parent">
                <span className="prop-text">{task.parent_task}</span>
              </PropertyRow>
            )}

            <PropertyRow label="ID">
              <code className="prop-id">{task.id}</code>
            </PropertyRow>
          </div>

          {/* Divider */}
          <hr className="detail-divider" />

          {/* Rendered Markdown Body */}
          {bodyHtml ? (
            <div
              ref={bodyRef}
              className="markdown-body"
              dangerouslySetInnerHTML={{ __html: bodyHtml }}
            />
          ) : (
            <p className="detail-empty">No content.</p>
          )}

          {/* Divider */}
          <hr className="detail-divider" />

          {/* Changelog Add */}
          <div className="changelog-section">
            <h3 className="changelog-title">{t('tasks.changelog')}</h3>
            <form onSubmit={handleAddChangelog} className="changelog-add">
              <input
                className="field-input"
                value={changelogEntry}
                onChange={e => setChangelogEntry(e.target.value)}
                placeholder="Add a changelog entry..."
              />
              <button
                type="submit"
                className="btn btn--primary"
                disabled={!changelogEntry.trim() || addChangelog.isPending}
              >
                {addChangelog.isPending ? '...' : t('tasks.add_entry')}
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
