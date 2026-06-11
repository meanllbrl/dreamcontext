import { useState, useMemo, useRef, useEffect } from 'react';
import { marked } from 'marked';
import mermaid from 'mermaid';
import panzoom from 'panzoom';
import type { Task, RiceFields, RiceInput } from '../../hooks/useTasks';
import { useUpdateTask, useAddTaskChangelog } from '../../hooks/useTasks';
import { usePlanningVersions } from '../../hooks/useVersions';
import { useI18n } from '../../context/I18nContext';
import { useTheme } from '../../context/ThemeContext';
import { tagHue } from '../../lib/tagColor';
import { initMermaid, normalizeMermaidSvg } from '../../lib/mermaidRender';
import './TaskDetailPanel.css';

marked.setOptions({ gfm: true, breaks: true });


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

/* ---------------------------------------------------------------------------
 * Acceptance-criteria <-> mermaid sync
 *
 * Convention:
 *   - An acceptance criterion line in markdown ends with `<!-- node:<id> -->`.
 *   - The mermaid block uses node IDs matching those `<id>` values.
 *   - Toggling a checkbox finds the corresponding mermaid node and rewrites
 *     its trailing `:::done|:::todo|:::active|:::blocked` class:
 *       - unchecked  -> `:::todo`
 *       - checked    -> `:::done`
 *     (`:::active` / `:::blocked` are not auto-detected; manual edits in the
 *      markdown source are preserved if the toggled checkbox doesn't reference
 *      them.)
 *
 * Example:
 *
 *   - [ ] Wire up auth <!-- node:step1 -->
 *
 *   ```mermaid
 *   flowchart TD
 *     step1[Auth]:::todo --> step2[Dashboard]
 *   ```
 *
 *   Checking the box rewrites `step1[Auth]:::todo` -> `step1[Auth]:::done`
 *   and flips the markdown line to `- [x]` in the same PATCH.
 *
 * Reverse direction (mermaid click -> checkbox) is intentionally NOT
 * implemented yet; mermaid's strict securityLevel disables `click` handlers
 * and binding them via the rendered SVG requires a non-trivial amount of code.
 * Treat this as future work.
 * ------------------------------------------------------------------------- */

const CHECKBOX_LINE_RE = /^(\s*[-*+]\s+)\[( |x|X)\](\s+)(.*)$/;

/** Toggle the Nth markdown checkbox line. Returns null if index out of bounds. */
function toggleCheckboxLine(body: string, index: number, checked: boolean): { body: string; nodeId: string | null } | null {
  const lines = body.split('\n');
  let count = 0;
  let inFence = false;
  let fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Track fenced code blocks so we ignore checkboxes inside them.
    const fenceMatch = /^(\s*)(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (!inFence) {
        inFence = true;
        fenceChar = fenceMatch[2];
      } else if (line.includes(fenceChar)) {
        inFence = false;
        fenceChar = '';
      }
      continue;
    }
    if (inFence) continue;
    const m = CHECKBOX_LINE_RE.exec(line);
    if (!m) continue;
    if (count === index) {
      const [, prefix, , spacing, rest] = m;
      const newBox = checked ? '[x]' : '[ ]';
      lines[i] = `${prefix}${newBox}${spacing}${rest}`;
      const nodeMatch = /<!--\s*node:([A-Za-z0-9_-]+)\s*-->/.exec(rest);
      return {
        body: lines.join('\n'),
        nodeId: nodeMatch ? nodeMatch[1] : null,
      };
    }
    count++;
  }
  return null;
}

/**
 * In every ```mermaid``` fenced block of `body`, find lines that contain
 * `nodeId` (as a whole word, not a substring) and rewrite the trailing
 * `:::status` class to `:::done` or `:::todo`. If no class is present, append
 * one. Lines like `classDef`, `class`, `style`, `linkStyle`, `click`, and
 * `subgraph` headers are skipped to avoid clobbering class definitions.
 */
// Edge-line operators in mermaid flowcharts. If a line contains any of these,
// it's an edge (link) statement rather than a node definition, and we MUST NOT
// rewrite `:::status` on it: e.g. `step1[A] --> step2[B]` would otherwise turn
// into `step1:::todo --> step2:::done` which is malformed and silently flips
// the wrong nodes. Node definitions never contain arrow operators.
const MERMAID_EDGE_RE = /-->|---|==>|==|-\.|~~~|\.->/;

function updateMermaidNodeStatus(body: string, nodeId: string, checked: boolean): string {
  const status = checked ? 'done' : 'todo';
  const escapedId = nodeId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the node ID in NODE DEFINITION position only: followed by `[label]`,
  // `(label)`, `{label}`, `:::class`, OR alone before whitespace/EOL.
  // Anchored to start-of-line (optional indent) so we don't match the ID
  // anywhere on a line that might also contain other tokens.
  const nodeDefRe = new RegExp(
    `^(\\s*)(${escapedId})((?:\\[[^\\]]*\\]|\\([^)]*\\)|\\{[^}]*\\})?)(\\s*:::(?:done|todo|active|blocked)\\b)?\\s*$`,
  );
  const lines = body.split('\n');
  let inMermaid = false;
  let fenceChar = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inMermaid) {
      const open = /^(\s*)(```|~~~)\s*mermaid\b/i.exec(line);
      if (open) {
        inMermaid = true;
        fenceChar = open[2];
      }
      continue;
    }
    if (line.trim().startsWith(fenceChar)) {
      inMermaid = false;
      fenceChar = '';
      continue;
    }
    // Skip lines that wouldn't be a node definition / usage in flowchart.
    if (/^\s*(classDef|class|style|linkStyle|click|subgraph|end)\b/.test(line)) continue;
    // Skip edge lines entirely — node definitions never have arrows.
    if (MERMAID_EDGE_RE.test(line)) continue;
    const m = nodeDefRe.exec(line);
    if (!m) continue;
    const [, indent, id, label] = m;
    lines[i] = `${indent}${id}${label ?? ''}:::${status}`;
  }
  return lines.join('\n');
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
  const { resolved: theme } = useTheme();
  const updateTask = useUpdateTask();
  const addChangelog = useAddTaskChangelog();
  const { data: versions } = usePlanningVersions();
  const [changelogEntry, setChangelogEntry] = useState('');
  const [newTag, setNewTag] = useState('');
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [riceExpanded, setRiceExpanded] = useState(initialRiceExpanded ?? !!task.rice);
  const [fullScreen, setFullScreen] = useState(false);

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

  const handleDueChange = (value: string) => {
    updateTask.mutate(
      { slug: task.slug, updates: { due_date: value || null } },
      { onError: onMutationError },
    );
  };

  const handleTagsChange = (tags: string[]) => {
    updateTask.mutate(
      { slug: task.slug, updates: { tags } },
      { onError: onMutationError },
    );
  };

  const handleAddTag = () => {
    const tag = newTag.trim();
    if (!tag) return;
    if (!task.tags.some(x => x.toLowerCase() === tag.toLowerCase())) {
      handleTagsChange([...task.tags, tag]);
    }
    setNewTag('');
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
  // bodySourceRef: last known SERVER body. Updated whenever the task prop
  // changes (i.e. after a successful PATCH + React Query invalidation).
  // Used as the rollback target if a PATCH fails.
  const bodySourceRef = useRef(task.body ?? '');
  // pendingBodyRef: optimistic body that successive checkbox toggles compute
  // against. Updated SYNCHRONOUSLY in onChange before the PATCH fires so that
  // rapid clicks on different checkboxes don't each compute from the same
  // pre-PATCH server snapshot (which would silently overwrite earlier toggles
  // once the later PATCH resolved).
  const pendingBodyRef = useRef<string>(task.body ?? '');
  useEffect(() => {
    // Server response arrived: refresh both refs to the fresh body.
    bodySourceRef.current = task.body ?? '';
    pendingBodyRef.current = task.body ?? '';
  }, [task.body]);

  // Stable refs to the latest mutation + error handler so the long-lived
  // 'change' listener never holds stale closures over them. We update these
  // every render (cheap) and the listener reads `.current` at event time.
  const updateTaskRef = useRef(updateTask);
  const onMutationErrorRef = useRef(onMutationError);
  useEffect(() => {
    updateTaskRef.current = updateTask;
    onMutationErrorRef.current = onMutationError;
  });

  // Enable inline acceptance-criterion checkboxes + delegate change events.
  // marked emits `<input type="checkbox" disabled>` for `- [ ]` / `- [x]`
  // task list items; we strip the disabled attr and index each input so we
  // can map a click back to the Nth checkbox in the markdown source.
  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !bodyHtml) return;

    const inputs = root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    inputs.forEach((el, i) => {
      el.removeAttribute('disabled');
      el.dataset.criterionIndex = String(i);
    });

    const onChange = (e: Event) => {
      const target = e.target as HTMLInputElement;
      if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
      const indexAttr = target.dataset.criterionIndex;
      if (indexAttr === undefined) return;
      const index = Number(indexAttr);
      const checked = target.checked;
      // Read from pendingBodyRef (optimistic, latest in-flight body) NOT
      // bodySourceRef. This avoids a race where a second toggle computes from
      // the pre-first-PATCH server body and silently overwrites the first
      // toggle when its PATCH resolves later.
      const current = pendingBodyRef.current;
      const toggled = toggleCheckboxLine(current, index, checked);
      if (!toggled) return;
      let nextBody = toggled.body;
      if (toggled.nodeId) {
        nextBody = updateMermaidNodeStatus(nextBody, toggled.nodeId, checked);
      }
      if (nextBody === current) return;
      // Commit optimistic body SYNCHRONOUSLY so the very next toggle (even if
      // fired before this PATCH resolves) sees it.
      pendingBodyRef.current = nextBody;
      // Optimistic: keep DOM checked state; persist via PATCH. On error we
      // revert the checkbox + roll pendingBodyRef back to the server source.
      updateTaskRef.current.mutate(
        { slug: task.slug, updates: { body: nextBody } },
        {
          onError: (err: Error) => {
            target.checked = !checked;
            pendingBodyRef.current = bodySourceRef.current;
            onMutationErrorRef.current(err);
          },
        },
      );
    };

    root.addEventListener('change', onChange);
    return () => root.removeEventListener('change', onChange);
  }, [bodyHtml, task.slug]);

  useEffect(() => {
    const root = bodyRef.current;
    if (!root || !bodyHtml) return;
    initMermaid(theme);

    let cancelled = false;
    const disposers: Array<() => void> = [];
    let rendering = false;

    const renderAll = async () => {
      if (cancelled || rendering) return;
      // Restore any previously-rendered mermaid wrappers to source form so a
      // theme change triggers a fresh render with the new palette.
      root.querySelectorAll<HTMLElement>('.mermaid-rendered').forEach((wrap) => {
        const src = wrap.dataset.mermaidSource;
        if (!src) return;
        const pre = document.createElement('pre');
        const code = document.createElement('code');
        code.className = 'language-mermaid';
        code.textContent = src;
        pre.appendChild(code);
        wrap.replaceWith(pre);
      });

      const blocks = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
      if (blocks.length === 0) return;

      rendering = true;
      // Tear down any prior panzoom/observer attachments before re-rendering.
      while (disposers.length) {
        const d = disposers.pop();
        try { d?.(); } catch { /* noop */ }
      }

      for (let i = 0; i < blocks.length; i++) {
        if (cancelled) break;
        const code = blocks[i] as HTMLElement;
        const pre = code.parentElement;
        if (!pre) continue;
        const source = sanitizeMermaid(code.textContent ?? '');
        const id = `mmd-${task.slug}-${i}-${Date.now().toString(36)}`;

        const wrap = document.createElement('div');
        wrap.className = 'mermaid-rendered';
        wrap.dataset.mermaidSource = source;

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

        try {
          const { svg, bindFunctions } = await mermaid.render(id, source);
          if (cancelled) break;
          stage.innerHTML = svg;
          bindFunctions?.(stage);
          wrap.dataset.mermaidRendered = '1';

          const svgEl = stage.querySelector('svg') as SVGSVGElement | null;
          if (!svgEl) continue;
          normalizeMermaidSvg(svgEl);
          // Lock SVG to its natural (viewBox) pixel size so panzoom transforms
          // scale predictably. Mermaid emits width="100%" which competes with
          // the panzoom transform and breaks the fit math.
          const vb = svgEl.viewBox.baseVal;
          const svgW = vb && vb.width > 0 ? vb.width : svgEl.getBoundingClientRect().width;
          const svgH = vb && vb.height > 0 ? vb.height : svgEl.getBoundingClientRect().height;
          svgEl.removeAttribute('width');
          svgEl.removeAttribute('height');
          svgEl.style.width = `${svgW}px`;
          svgEl.style.height = `${svgH}px`;
          svgEl.style.maxWidth = 'none';
          svgEl.style.transformOrigin = '0 0';

          const pz = panzoom(svgEl, {
            maxZoom: 12,
            minZoom: 0.15,
            bounds: false,
            zoomDoubleClickSpeed: 1.6,
            smoothScroll: false,
          });

          const fit = () => {
            try {
              const stageBox = stage.getBoundingClientRect();
              if (stageBox.width === 0 || stageBox.height === 0) return;
              const padding = 32;
              const scale = Math.min(
                (stageBox.width - padding) / svgW,
                (stageBox.height - padding) / svgH,
                1,
              );
              pz.zoomAbs(0, 0, 1);
              pz.moveTo(0, 0);
              pz.zoomAbs(0, 0, scale);
              const tx = (stageBox.width - svgW * scale) / 2;
              const ty = (stageBox.height - svgH * scale) / 2;
              pz.moveTo(tx, ty);
            } catch { /* noop */ }
          };
          requestAnimationFrame(() => requestAnimationFrame(fit));
          const ro = new ResizeObserver(() => fit());
          ro.observe(stage);

          // ── Click-to-zoom on individual nodes.
          // Animates the panzoom transform so the clicked node fills ~60% of the
          // stage. Clicking the stage background (or the SAME node twice) fits
          // back to the full diagram view.
          let zoomedNode: Element | null = null;
          const zoomToNode = (node: Element) => {
            try {
              const nodeRect = node.getBoundingClientRect();
              const stageBox = stage.getBoundingClientRect();
              if (nodeRect.width === 0) return;
              const cx = nodeRect.left + nodeRect.width / 2 - stageBox.left;
              const cy = nodeRect.top + nodeRect.height / 2 - stageBox.top;
              const desiredScale = Math.min(
                (stageBox.width * 0.6) / nodeRect.width,
                (stageBox.height * 0.6) / nodeRect.height,
                6,
              );
              const t = pz.getTransform();
              const mult = desiredScale / t.scale;
              if (Math.abs(mult - 1) < 0.01) return;
              pz.smoothZoom(cx, cy, mult);
            } catch { /* noop */ }
          };

          const onStageClick = (e: MouseEvent) => {
            const target = e.target as Element | null;
            const node = target?.closest('g.node, g.cluster') ?? null;
            if (!node) {
              // Click on empty stage — reset to fit.
              if (zoomedNode) { zoomedNode = null; fit(); }
              return;
            }
            if (zoomedNode === node) {
              // Second click on same node — unzoom.
              zoomedNode = null;
              fit();
            } else {
              zoomedNode = node;
              zoomToNode(node);
            }
          };
          stage.addEventListener('click', onStageClick);
          // Visual affordance: zoomable nodes get a pointer cursor.
          svgEl.querySelectorAll<HTMLElement>('g.node, g.cluster').forEach((n) => {
            n.style.cursor = 'zoom-in';
          });

          controls.addEventListener('click', (e) => {
            e.stopPropagation();
            const btn = (e.target as HTMLElement).closest('button');
            if (!btn) return;
            const stageBox = stage.getBoundingClientRect();
            const cx = stageBox.width / 2;
            const cy = stageBox.height / 2;
            const act = btn.getAttribute('data-act');
            if (act === 'in') pz.smoothZoom(cx, cy, 1.4);
            else if (act === 'out') pz.smoothZoom(cx, cy, 1 / 1.4);
            else if (act === 'reset') { zoomedNode = null; fit(); }
          });

          disposers.push(() => {
            ro.disconnect();
            stage.removeEventListener('click', onStageClick);
            pz.dispose();
          });
        } catch (err) {
          if (cancelled) break;
          const msg = err instanceof Error ? err.message : String(err);
          stage.innerHTML = `<pre class="mermaid-error">Mermaid render failed: ${msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)}</pre>`;
        }
      }
      rendering = false;
    };

    // Initial render.
    renderAll();

    // Self-healing: if React re-injects bodyHtml (or HMR), raw <pre><code> may
    // reappear without the effect re-firing. A MutationObserver triggers a
    // re-render whenever raw mermaid code exists but no rendered SVG.
    const observer = new MutationObserver(() => {
      if (cancelled || rendering) return;
      const hasRaw = root.querySelector('pre > code.language-mermaid');
      const hasRendered = root.querySelector('.mermaid-rendered .mermaid-stage svg');
      if (hasRaw && (!hasRendered || hasRaw)) {
        // Only re-render if there's actually raw code waiting.
        if (hasRaw) renderAll();
      }
    });
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      cancelled = true;
      observer.disconnect();
      while (disposers.length) {
        const d = disposers.pop();
        try { d?.(); } catch { /* noop */ }
      }
    };
  }, [bodyHtml, task.slug, theme]);

  return (
    <div className={`detail-overlay ${fullScreen ? 'detail-overlay--fullscreen' : ''}`} onClick={onClose}>
      <div className={`detail-panel ${fullScreen ? 'detail-panel--fullscreen' : ''}`} onClick={e => e.stopPropagation()}>
        <div className="detail-header">
          <h2 className="detail-title">{task.name}</h2>
          <div className="detail-header-actions">
            <button
              type="button"
              className="detail-icon-btn"
              onClick={() => setFullScreen((v) => !v)}
              title={fullScreen ? 'Exit full-page view' : 'Open in full page'}
              aria-label={fullScreen ? 'Exit full-page view' : 'Open in full page'}
            >
              {fullScreen ? (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 3v3H3M10 3v3h3M6 13v-3H3M10 13v-3h3" />
                </svg>
              ) : (
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
                </svg>
              )}
            </button>
            <button className="modal-close" onClick={onClose} aria-label="Close">&times;</button>
          </div>
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

            <PropertyRow label="Due">
              <input
                type="date"
                className="field-select prop-select"
                value={task.due_date ?? ''}
                onChange={e => handleDueChange(e.target.value)}
              />
            </PropertyRow>

            <PropertyRow label="Tags">
              <div className="prop-tags prop-tags--editable">
                {task.tags.map(tag => (
                  <span key={tag} className="task-tag" data-hue={tagHue(tag)}>
                    {tag}
                    <button
                      type="button"
                      className="task-tag-remove"
                      aria-label={`Remove tag ${tag}`}
                      onClick={() => handleTagsChange(task.tags.filter(x => x !== tag))}
                    >
                      ×
                    </button>
                  </span>
                ))}
                <input
                  className="task-tag-input"
                  value={newTag}
                  placeholder="+ tag"
                  aria-label="Add tag"
                  onChange={e => setNewTag(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      handleAddTag();
                    }
                  }}
                  onBlur={handleAddTag}
                />
              </div>
            </PropertyRow>

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
