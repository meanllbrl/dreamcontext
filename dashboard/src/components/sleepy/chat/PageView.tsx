import { useCallback, useRef, useState } from 'react';
import { agentFileUrl } from '../../../api/client';
import { useVault } from '../../../context/VaultContext';
import { MarkdownPreview } from '../../core/MarkdownPreview';
import { holdsItsWidth } from '../../../lib/markdownTables';
import { ActionRow } from './ActionRow';
import type { ChatAction } from './chatActions';
import type {
  PageViewSpec,
  PageWidget,
  StackWidget as StackWidgetSpec,
  RailWidget as RailWidgetSpec,
  CardWidget as CardWidgetSpec,
  TableWidget as TableWidgetSpec,
  TextWidget as TextWidgetSpec,
  StatWidget as StatWidgetSpec,
  ImageWidget as ImageWidgetSpec,
  DividerWidget as DividerWidgetSpec,
} from '../../../lib/chatViewSpec';
import './PageView.css';

/**
 * The `dream-view` `type: "page"` payload, drawn — a research/comparison answer as widgets
 * instead of a wall of prose. See `_dream_context/state/assets/chat-interactive-views-plan-v2.md`
 * §1.2 for the schema this renders and §1.15 for the remote-image mitigations below.
 *
 * `spec` arrives already validated, capped and depth-checked by `lib/chatViewSpec.ts`
 * (`parseViewBlock`) — this component trusts its shape completely and does no re-validation.
 *
 * Two containers, two scroll axes: a `stack` is vertical and lets the transcript's own Y
 * scroller carry any overflow; a `rail` is horizontal (`overflow-x: auto`, scroll-snap,
 * never wraps) — the carousel a photo-heavy "research cars for me" answer needs. A wide
 * `table` gets a third, independent horizontal scroller of its own.
 */

interface WidgetHandlers {
  onAction?: (a: ChatAction) => void;
  onOpenFile?: (path: string) => void;
}

const REMOTE_SRC_RE = /^https:\/\//i;

/** An image src coming out of `sanitizeImageSrc` is always either an `https:` URL or a
 *  project-relative path — nothing else survives validation. Local paths need the
 *  vault-aware file endpoint; remote ones are used exactly as written (query/fragment
 *  already stripped upstream). A module function, not a component — the vault comes from
 *  whichever component calls it. */
function resolveImage(vault: string | null, src: string): { url: string; remote: boolean } {
  const remote = REMOTE_SRC_RE.test(src);
  return { url: remote ? src : agentFileUrl(vault, src, { raw: true }), remote };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function PageView({
  spec, onAction, onOpenFile,
}: {
  spec: PageViewSpec;
  onAction?: (a: ChatAction) => void;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div className="chat-pv">
      {(spec.title || spec.subtitle) && (
        <header className="chat-pv-header">
          {spec.title && <h3 className="chat-pv-title">{spec.title}</h3>}
          {spec.subtitle && <p className="chat-pv-subtitle">{spec.subtitle}</p>}
        </header>
      )}
      <div className="chat-pv-body">
        {spec.body.map((widget, i) => (
          <Widget key={i} widget={widget} onAction={onAction} onOpenFile={onOpenFile} />
        ))}
      </div>
    </div>
  );
}

/** The one place a widget's `kind` decides what renders. Recurses for the two containers;
 *  every leaf is terminal. */
function Widget({ widget, onAction, onOpenFile }: { widget: PageWidget } & WidgetHandlers) {
  switch (widget.kind) {
    case 'stack': return <Stack widget={widget} onAction={onAction} onOpenFile={onOpenFile} />;
    case 'rail': return <Rail widget={widget} onAction={onAction} onOpenFile={onOpenFile} />;
    case 'card': return <Card widget={widget} onAction={onAction} />;
    case 'table': return <TableWidget widget={widget} />;
    case 'text': return <Text widget={widget} />;
    case 'stat': return <Stat widget={widget} />;
    case 'image': return <ImageWidget widget={widget} onOpenFile={onOpenFile} />;
    case 'divider': return <Divider widget={widget} />;
    default: return null;
  }
}

// ─── stack — vertical; children full width, overflow left to the transcript's Y scroller ──

function Stack({ widget, onAction, onOpenFile }: { widget: StackWidgetSpec } & WidgetHandlers) {
  return (
    <div className="chat-pv-stack">
      {widget.title && <h4 className="chat-pv-section-title">{widget.title}</h4>}
      {widget.items.map((child, i) => (
        <Widget key={i} widget={child} onAction={onAction} onOpenFile={onOpenFile} />
      ))}
    </div>
  );
}

// ─── rail — horizontal; the carousel. Never wraps; scroll-snapped; keyboard-operable ──────

function Rail({ widget, onAction, onOpenFile }: { widget: RailWidgetSpec } & WidgetHandlers) {
  const railRef = useRef<HTMLDivElement | null>(null);
  const [edge, setEdge] = useState({ start: false, end: false });

  const updateEdges = useCallback(() => {
    const el = railRef.current;
    if (!el) return;
    setEdge({
      start: el.scrollLeft > 2,
      end: el.scrollLeft + el.clientWidth < el.scrollWidth - 2,
    });
  }, []);

  const railRefCb = useCallback((el: HTMLDivElement | null) => {
    railRef.current = el;
    if (!el) return;
    // Measured on mount and whenever the rail's own box (or its content) changes size — a
    // still-streaming page can grow the last card, or the pane itself can be resized.
    const ro = new ResizeObserver(updateEdges);
    ro.observe(el);
    updateEdges();
  }, [updateEdges]);

  const scrollByCard = useCallback((dir: 1 | -1) => {
    const el = railRef.current;
    if (!el) return;
    const first = el.firstElementChild as HTMLElement | null;
    const gap = parseFloat(getComputedStyle(el).columnGap || '0') || 0;
    const step = first ? first.getBoundingClientRect().width + gap : el.clientWidth * 0.9;
    el.scrollBy({ left: dir * step, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); scrollByCard(1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); scrollByCard(-1); }
  }, [scrollByCard]);

  return (
    <div className="chat-pv-rail-wrap">
      {widget.title && <h4 className="chat-pv-section-title">{widget.title}</h4>}
      <div
        className="chat-pv-rail-shell"
        data-edge-start={edge.start || undefined}
        data-edge-end={edge.end || undefined}
      >
        <div
          ref={railRefCb}
          className="chat-pv-rail"
          role="group"
          aria-label={widget.title || 'Scrollable row of items — use the left and right arrow keys to scroll'}
          tabIndex={0}
          onKeyDown={onKeyDown}
          onScroll={updateEdges}
        >
          {widget.items.map((child, i) => (
            <Widget key={i} widget={child} onAction={onAction} onOpenFile={onOpenFile} />
          ))}
        </div>
        <span className="chat-pv-rail-fade chat-pv-rail-fade-start" aria-hidden="true" />
        <span className="chat-pv-rail-fade chat-pv-rail-fade-end" aria-hidden="true" />
      </div>
    </div>
  );
}

// ─── card — the owner's whole named list: photo, price, badges, specs, body, actions ─────

function CardImage({ image }: { image: { src: string; alt: string } }) {
  const { vault } = useVault();
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const { url } = resolveImage(vault, image.src);
  return (
    <div className="chat-pv-card-media">
      <img
        src={url}
        alt={image.alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="chat-pv-card-img"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function Card({ widget, onAction }: { widget: CardWidgetSpec; onAction?: (a: ChatAction) => void }) {
  return (
    <article className="chat-pv-card" tabIndex={0} aria-label={widget.title}>
      {widget.image && <CardImage image={widget.image} />}
      <div className="chat-pv-card-body">
        <h4 className="chat-pv-card-title">{widget.title}</h4>
        {widget.subtitle && <p className="chat-pv-card-subtitle">{widget.subtitle}</p>}
        {widget.price && (
          <div className="chat-pv-card-price">
            {/* Verbatim — a string the agent already formatted (currency, locale grouping,
                a range). No parsing, no reformatting: see plan §1.2. */}
            <span className="chat-pv-card-price-amount">{widget.price.amount}</span>
            {widget.price.note && <span className="chat-pv-card-price-note">{widget.price.note}</span>}
          </div>
        )}
        {widget.badges && widget.badges.length > 0 && (
          <ul className="chat-pv-card-badges">
            {widget.badges.map((b, i) => <li key={`${i}-${b}`} className="chat-pv-card-badge">{b}</li>)}
          </ul>
        )}
        {widget.specs && widget.specs.length > 0 && (
          <div className="chat-pv-card-specs">
            {widget.specs.map((s, i) => (
              <div className="chat-pv-card-spec" key={`${i}-${s.label}`}>
                <span className="chat-pv-card-spec-label">{s.label}</span>
                <span className="chat-pv-card-spec-value">{s.value}</span>
              </div>
            ))}
          </div>
        )}
        {widget.body && (
          <div className="chat-pv-card-text">
            <MarkdownPreview content={widget.body} />
          </div>
        )}
        {widget.actions && widget.actions.length > 0 && onAction && (
          <ActionRow actions={widget.actions} onAction={onAction} />
        )}
      </div>
    </article>
  );
}

// ─── table — the N-column comparison grid (plan B8); its own horizontal scroller ─────────

/**
 * The per-cell width mark, the same one the answer's markdown tables carry: a short cell holds
 * its width, a long one is free to wrap and to break a token that doesn't fit. Positive on both
 * sides — see lib/markdownTables.ts for why the complement is never expressed as `:not()`.
 */
function cellFit(text: string): { 'data-fit'?: '' } | { 'data-wrap'?: '' } {
  return holdsItsWidth(text) ? { 'data-fit': '' } : { 'data-wrap': '' };
}

function TableWidget({ widget }: { widget: TableWidgetSpec }) {
  return (
    <div className="chat-pv-table-wrap">
      <table className="chat-pv-table">
        {widget.caption && <caption className="chat-pv-table-caption">{widget.caption}</caption>}
        <thead>
          <tr>
            {/* `data-fit` is the same column model the answer's own markdown tables use: a
                short cell holds its width, a long one wraps and lets the short columns keep
                theirs. Decided here rather than in CSS because only the content knows.
                See lib/markdownTables.ts. */}
            {widget.headers.map((h, i) => <th key={i} scope="col" {...cellFit(h)}>{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {widget.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => <td key={ci} {...cellFit(cell)}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── text — markdown through the SAME MarkdownPreview as everything else in the chat ─────

function Text({ widget }: { widget: TextWidgetSpec }) {
  return (
    <div className="chat-pv-text">
      <MarkdownPreview content={widget.text} />
    </div>
  );
}

// ─── stat — a row of headline numbers ─────────────────────────────────────────────────────

function Stat({ widget }: { widget: StatWidgetSpec }) {
  return (
    <div className="chat-pv-stat">
      {widget.items.map((it, i) => (
        <div className="chat-pv-stat-item" key={i}>
          <span className="chat-pv-stat-value">{it.value}</span>
          <span className="chat-pv-stat-label">{it.label}</span>
          {it.note && <span className="chat-pv-stat-note">{it.note}</span>}
        </div>
      ))}
    </div>
  );
}

// ─── image — a standalone photo; local ones zoom into the existing lightbox ───────────────

function ImageWidget({ widget, onOpenFile }: { widget: ImageWidgetSpec; onOpenFile?: (path: string) => void }) {
  const { vault } = useVault();
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const { url, remote } = resolveImage(vault, widget.src);
  const img = (
    <img
      src={url}
      alt={widget.alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className="chat-pv-image-img"
      onError={() => setFailed(true)}
    />
  );
  // Only a project-relative path can be handed back to `onOpenFile` — it re-resolves and
  // classifies the path itself (see ChatPane.handleOpenFile), which a remote URL would
  // defeat. A remote photo is shown, not zoomable, for the same reason it isn't clickable
  // in an ordinary markdown answer either.
  const clickable = !remote && !!onOpenFile;
  return (
    <figure className="chat-pv-image">
      {clickable ? (
        <button
          type="button"
          className="chat-pv-image-btn"
          onClick={() => onOpenFile!(widget.src)}
          aria-label={`Open ${widget.alt || 'image'} full size`}
        >
          {img}
        </button>
      ) : img}
      {widget.caption && <figcaption className="chat-pv-image-caption">{widget.caption}</figcaption>}
    </figure>
  );
}

// ─── divider ───────────────────────────────────────────────────────────────────────────────

function Divider({ widget }: { widget: DividerWidgetSpec }) {
  if (!widget.label) return <hr className="chat-pv-divider" />;
  return (
    <div className="chat-pv-divider chat-pv-divider--labeled" role="separator" aria-label={widget.label}>
      <span className="chat-pv-divider-label">{widget.label}</span>
    </div>
  );
}
