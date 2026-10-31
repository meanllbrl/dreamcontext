import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { GraphGroup, GraphNode } from '../../hooks/useGraph';
import { useGraphSpace, type SpacePoint } from '../../hooks/useGraphSpace';
import { useRecall } from '../../hooks/useRecall';
import { parseQuery } from '../../lib/obsidian-search';
import './BrainSpace.css';

/**
 * The Brain "meaning space": one static 2D canvas. Positions come precomputed from the server
 * (UMAP over the existing embeddings), so there is no simulation — related notes already sit
 * together and the view costs nothing while idle (it only redraws when something changes).
 */

interface View {
  /** World point shown at the canvas centre. */
  cx: number;
  cy: number;
  /** CSS pixels per world unit. */
  k: number;
}

export interface BrainSpaceProps {
  nodes: GraphNode[];
  isDark: boolean;
  colors: Record<GraphGroup, string>;
  /** The page's selected graph node (null when its drawer is closed). */
  selectedId: string | null;
  /** Called with a graph node id when the point has one (opens the full drawer), else null. */
  onSelect: (id: string | null) => void;
}

const HIT_RADIUS = 9;
const LABEL_REL_ZOOM = 3.5; // zoom relative to the fitted view at which node titles appear
const MAX_LABELS = 70;
/** While searching, only the best few matches get a title — more just stack on top of each other. */
const MAX_SEARCH_LABELS = 12;

function clip(text: string, max = 42): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** Colours for corpus types the link graph has no group for (the graph palette covers the rest). */
const EXTRA_COLORS: Record<string, string> = {
  changelog: '#64748b',
  objective: '#ec4899',
  insight: '#14b8a6',
  thesis: '#f97316',
  automation: '#eab308',
  whiteboard: '#06b6d4',
  agent: '#8b5cf6',
  skill: '#84cc16',
};

interface Placed extends SpacePoint {
  /** A graph-node-shaped view of the point (the search parser and tooltip read this shape). */
  node: GraphNode;
  /** Lower-cased haystack for the cheap text filter. */
  hay: string;
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function BrainSpace({ nodes, isDark, colors, selectedId, onSelect }: BrainSpaceProps) {
  const { data: space, isLoading, error } = useGraphSpace();

  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const viewRef = useRef<View>({ cx: 0, cy: 0, k: 300 });
  const dirtyRef = useRef(true);
  const rafRef = useRef(0);
  const flyRef = useRef<{ from: View; to: View; t0: number } | null>(null);
  const fittedRef = useRef(false);
  /** `k` of the fitted view — all zoom thresholds are relative to it so they hold at any window size. */
  const fitKRef = useRef(300);

  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const [query, setQuery] = useState('');
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  /** The point carrying the selection ring — a point may have no graph node to hand the page. */
  const [sel, setSel] = useState<string | null>(null);
  const [tag, setTag] = useState('');

  const debounced = useDebounced(query, 250);
  const recall = useRecall(debounced, [], 40);

  // ── Data join: server positions × graph metadata ────────────────────────
  const placed: Placed[] = useMemo(() => {
    if (space?.state !== 'ready') return [];
    return space.points.map((p) => {
      const node: GraphNode = {
        id: p.id,
        label: p.l,
        group: p.t as GraphGroup,
        path: p.p,
        meta: { status: p.s, tags: p.g, description: p.d },
      };
      const hay = `${p.l} ${p.p} ${p.g.join(' ')} ${p.d}`.toLowerCase();
      return { ...p, node, hay };
    });
  }, [space]);

  const graphIds = useMemo(() => new Set(nodes.map((n) => n.id)), [nodes]);
  const colorOf = useCallback(
    (type: string): string => colors[type as GraphGroup] ?? EXTRA_COLORS[type] ?? '#9ca3af',
    [colors],
  );

  const groupCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of placed) m.set(p.t, (m.get(p.t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [placed]);

  const topTags = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of placed) for (const t of p.g) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
  }, [placed]);

  // ── Filter (hides) + search (highlights) ────────────────────────────────
  const visible = useMemo(
    () =>
      placed.filter(
        (p) => !hidden.has(p.t) && (!tag || p.g.includes(tag)),
      ),
    [placed, hidden, tag],
  );

  // Cluster names follow the VISIBLE points: a label for a cluster whose members are all filtered
  // out would float over empty space, and one for a half-hidden cluster belongs at the centre of
  // what is still shown.
  const visibleClusters = useMemo(() => {
    if (space?.state !== 'ready') return [];
    const acc = new Map<number, { x: number; y: number; n: number }>();
    for (const p of visible) {
      const a = acc.get(p.c) ?? { x: 0, y: 0, n: 0 };
      a.x += p.x; a.y += p.y; a.n++;
      acc.set(p.c, a);
    }
    return space.clusters
      .filter((c) => acc.has(c.id))
      .map((c) => {
        const a = acc.get(c.id)!;
        return { id: c.id, label: c.label, x: a.x / a.n, y: a.y / a.n, size: a.n };
      });
  }, [space, visible]);

  const parsed = useMemo(() => parseQuery(query), [query]);
  // Keyed by corpus identity, not path: every changelog entry shares one file.
  const recallKeys = useMemo(() => {
    const m = new Map<string, number>();
    (recall.data?.hits ?? []).forEach((h, i) => m.set(`${h.type}/${h.slug}`, i));
    return m;
  }, [recall.data]);

  /** id → rank (lower is better); undefined when no search is active. */
  const matches = useMemo(() => {
    if (parsed.isEmpty) return null;
    const out = new Map<string, number>();
    // A natural-language query rarely appears verbatim, so the text fallback needs EVERY word.
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    for (const p of visible) {
      const r = recallKeys.get(p.id);
      if (r !== undefined) out.set(p.id, r);
      else if (parsed.match(p.node) || words.every((w) => p.hay.includes(w))) out.set(p.id, 1000);
    }
    // Still waiting on the semantic hits and nothing matched by text: don't grey the whole map out.
    if (out.size === 0 && recall.isFetching) return null;
    return out;
  }, [parsed, visible, recallKeys, query, recall.isFetching]);

  const results = useMemo(() => {
    if (!matches) return [];
    return visible
      .filter((p) => matches.has(p.id))
      .sort((a, b) => (matches.get(a.id) ?? 0) - (matches.get(b.id) ?? 0))
      .slice(0, 8);
  }, [matches, visible]);

  // ── Canvas plumbing ─────────────────────────────────────────────────────
  const invalidate = useCallback(() => {
    dirtyRef.current = true;
  }, []);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(
    (animate: boolean) => {
      const pts = visible.length ? visible : placed;
      if (!pts.length || !size.w) return;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const p of pts) {
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      // Leave the toolbar (search + chips, ~150px) clear at the top.
      const padX = 70, padTop = 170, padBottom = 50;
      const k = Math.min(
        (size.w - padX * 2) / Math.max(maxX - minX, 0.05),
        (size.h - padTop - padBottom) / Math.max(maxY - minY, 0.05),
      );
      // The framed area's centre sits (padTop - padBottom)/2 px below the canvas centre.
      const to = { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 - (padTop - padBottom) / 2 / k, k };
      fitKRef.current = k;
      if (animate) flyRef.current = { from: { ...viewRef.current }, to, t0: performance.now() };
      else viewRef.current = to;
      invalidate();
    },
    [visible, placed, size.w, size.h, invalidate],
  );

  useEffect(() => {
    if (fittedRef.current || !placed.length || !size.w) return;
    fittedRef.current = true;
    fit(false);
  }, [placed, size.w, fit]);

  // A filter change reshapes the visible set — re-frame it (skipping the very first render).
  const filterMountedRef = useRef(false);
  useEffect(() => {
    if (!filterMountedRef.current) {
      filterMountedRef.current = true;
      return;
    }
    fit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hidden, tag]);

  const flyTo = useCallback(
    (p: SpacePoint) => {
      const from = { ...viewRef.current };
      flyRef.current = { from, to: { cx: p.x, cy: p.y, k: Math.max(from.k, fitKRef.current * LABEL_REL_ZOOM * 1.1) }, t0: performance.now() };
      invalidate();
    },
    [invalidate],
  );

  // Cluster label under the cursor / for fade decisions.
  const idToPlaced = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed]);

  /** Select a point: tell the page when a graph node can open the full drawer, else show the card here. */
  const select = useCallback(
    (p: Placed | null) => {
      setSel(p ? p.id : null);
      onSelect(p?.n && graphIds.has(p.n) ? p.n : null);
    },
    [onSelect, graphIds],
  );

  // The page closed its drawer → drop our ring too (only for points that opened it).
  useEffect(() => {
    if (selectedId === null) setSel((cur) => (cur && idToPlaced.get(cur)?.n ? null : cur));
  }, [selectedId, idToPlaced]);

  // Spatial grid in WORLD space → O(1) hover instead of scanning every point on pointermove.
  const grid = useMemo(() => {
    const CELL = 0.02;
    const m = new Map<string, Placed[]>();
    for (const p of visible) {
      const key = `${Math.floor(p.x / CELL)},${Math.floor(p.y / CELL)}`;
      const arr = m.get(key);
      if (arr) arr.push(p);
      else m.set(key, [p]);
    }
    return { CELL, m };
  }, [visible]);

  const pick = useCallback(
    (sx: number, sy: number): Placed | null => {
      const v = viewRef.current;
      const wx = (sx - size.w / 2) / v.k + v.cx;
      const wy = (sy - size.h / 2) / v.k + v.cy;
      const r = HIT_RADIUS / v.k;
      const { CELL, m } = grid;
      let best: Placed | null = null;
      let bd = Infinity;
      for (let gx = Math.floor((wx - r) / CELL); gx <= Math.floor((wx + r) / CELL); gx++) {
        for (let gy = Math.floor((wy - r) / CELL); gy <= Math.floor((wy + r) / CELL); gy++) {
          const arr = m.get(`${gx},${gy}`);
          if (!arr) continue;
          for (const p of arr) {
            const d = (p.x - wx) ** 2 + (p.y - wy) ** 2;
            if (d < bd && d <= r * r) { bd = d; best = p; }
          }
        }
      }
      return best;
    },
    [grid, size.w, size.h],
  );

  // ── Draw loop (only paints when dirty) ──────────────────────────────────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size.w) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size.w * dpr;
    canvas.height = size.h * dpr;
    invalidate();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const labelInk = isDark ? 'rgba(235,240,250,0.95)' : 'rgba(20,24,36,0.92)';
    const clusterInk = isDark ? 'rgba(200,210,230,0.55)' : 'rgba(40,48,70,0.5)';
    const bgPill = isDark ? 'rgba(21,21,24,0.72)' : 'rgba(255,255,255,0.78)';

    const frame = (now: number) => {
      const fly = flyRef.current;
      if (fly) {
        const t = Math.min(1, (now - fly.t0) / 520);
        const e = 1 - Math.pow(1 - t, 3);
        viewRef.current = {
          cx: fly.from.cx + (fly.to.cx - fly.from.cx) * e,
          cy: fly.from.cy + (fly.to.cy - fly.from.cy) * e,
          k: fly.from.k * Math.pow(fly.to.k / fly.from.k, e),
        };
        if (t >= 1) flyRef.current = null;
        dirtyRef.current = true;
      }
      if (dirtyRef.current) {
        dirtyRef.current = false;
        const v = viewRef.current;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, size.w, size.h);
        const sx = (x: number) => (x - v.cx) * v.k + size.w / 2;
        const sy = (y: number) => (y - v.cy) * v.k + size.h / 2;

        const searching = matches !== null;
        const r = Math.max(2.2, Math.min(5.5, 1.6 + v.k / 140));

        // Dim points first, then lit ones on top so highlights are never buried.
        const lit: Placed[] = [];
        for (const p of visible) {
          const x = sx(p.x), y = sy(p.y);
          if (x < -8 || y < -8 || x > size.w + 8 || y > size.h + 8) continue;
          const on = !searching || matches!.has(p.id);
          if (on) { lit.push(p); continue; }
          ctx.globalAlpha = 0.12;
          ctx.fillStyle = colorOf(p.t);
          ctx.beginPath();
          ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = searching ? 1 : 0.82;
        for (const p of lit) {
          ctx.fillStyle = colorOf(p.t);
          ctx.beginPath();
          ctx.arc(sx(p.x), sy(p.y), searching ? r * 1.35 : r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;

        // Cluster names fade out as individual titles fade in.
        const z = v.k / fitKRef.current;
        const cf = Math.max(0, Math.min(1, (3.2 - z) / 1.6));
        if (cf > 0.02) {
          ctx.font = `600 13px -apple-system, BlinkMacSystemFont, 'Visby CF', sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.globalAlpha = cf * (searching ? 0.5 : 1);
          ctx.fillStyle = clusterInk;
          for (const c of visibleClusters) {
            const x = sx(c.x), y = sy(c.y);
            const w = ctx.measureText(c.label).width;
            ctx.save();
            ctx.globalAlpha = cf * (searching ? 0.5 : 1) * 0.8;
            ctx.fillStyle = bgPill;
            ctx.fillRect(x - w / 2 - 5, y - 10, w + 10, 20);
            ctx.restore();
            ctx.fillStyle = clusterInk;
            ctx.fillText(c.label, x, y);
          }
          ctx.globalAlpha = 1;
        }

        // Titles: hovered/selected always; others only when zoomed in (or matched).
        const drawLabel = (p: Placed, strong: boolean) => {
          const x = sx(p.x), y = sy(p.y) - r - 5;
          ctx.font = `${strong ? 600 : 500} 12px -apple-system, BlinkMacSystemFont, 'Visby CF', sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          const text = clip(p.node.label);
          const w = ctx.measureText(text).width;
          ctx.fillStyle = bgPill;
          ctx.fillRect(x - w / 2 - 4, y - 15, w + 8, 17);
          ctx.fillStyle = labelInk;
          ctx.fillText(text, x, y);
        };
        let shown = 0;
        if (z >= LABEL_REL_ZOOM || searching) {
          const pool = searching
            ? [...lit].sort((a, b) => (matches!.get(a.id) ?? 0) - (matches!.get(b.id) ?? 0))
            : visible;
          for (const p of pool) {
            if (shown >= (searching ? MAX_SEARCH_LABELS : MAX_LABELS)) break;
            const x = sx(p.x), y = sy(p.y);
            if (x < 0 || y < 0 || x > size.w || y > size.h) continue;
            drawLabel(p, false);
            shown++;
          }
        }
        for (const id of [sel, hoverId]) {
          const p = id ? idToPlaced.get(id) : undefined;
          if (!p) continue;
          ctx.strokeStyle = labelInk;
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(sx(p.x), sy(p.y), r + 3, 0, Math.PI * 2);
          ctx.stroke();
          drawLabel(p, true);
        }
      }
      rafRef.current = requestAnimationFrame(frame);
    };
    rafRef.current = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafRef.current);
  }, [size, isDark, colorOf, visible, visibleClusters, matches, sel, hoverId, idToPlaced, invalidate]);

  // ── Pointer: pan, zoom, hover, click ────────────────────────────────────
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, moved: false };
    flyRef.current = null;
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const d = dragRef.current;
    if (d) {
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      if (d.moved) {
        const v = viewRef.current;
        viewRef.current = { ...v, cx: v.cx - dx / v.k, cy: v.cy - dy / v.k };
        d.x = e.clientX; d.y = e.clientY;
        setHoverId(null);
        invalidate();
        return;
      }
    }
    const p = pick(e.clientX - rect.left, e.clientY - rect.top);
    const id = p?.id ?? null;
    if (id !== hoverId) setHoverId(id);
    setHoverPos(p ? { x: e.clientX - rect.left, y: e.clientY - rect.top } : null);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.moved) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const p = pick(e.clientX - rect.left, e.clientY - rect.top);
    select(p);
  };

  // Wheel needs a non-passive listener to preventDefault.
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const v = viewRef.current;
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016));
      const k = Math.max(60, Math.min(6000, v.k * factor));
      // Keep the world point under the cursor fixed.
      const wx = (mx - size.w / 2) / v.k + v.cx;
      const wy = (my - size.h / 2) / v.k + v.cy;
      viewRef.current = { k, cx: wx - (mx - size.w / 2) / k, cy: wy - (my - size.h / 2) / k };
      flyRef.current = null;
      invalidate();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [size.w, size.h, invalidate]);

  const toggleGroup = (g: string) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  const hoverNode = hoverId ? idToPlaced.get(hoverId)?.node : undefined;
  const selPoint = sel ? idToPlaced.get(sel) : undefined;
  const pending = isLoading;
  const unavailable = space?.state === 'unavailable' ? space : null;

  return (
    <div className="brain-space" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="brain-space-canvas"
        style={{ width: size.w, height: size.h }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { setHoverId(null); setHoverPos(null); }}
      />

      {space?.state === 'ready' && (
        <div className="brain-space-toolbar">
          <div className="brain-space-search">
            <input
              className="brain-space-input"
              placeholder="Search by meaning or title…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setQuery('');
                if (e.key === 'Enter' && results[0]) {
                  flyTo(results[0]);
                  select(results[0]);
                }
              }}
            />
            {query && (
              <button className="brain-space-clear" onClick={() => setQuery('')} aria-label="Clear search">
                ×
              </button>
            )}
            {results.length > 0 && (
              <ul className="brain-space-results">
                {results.map((p) => (
                  <li key={p.id}>
                    <button
                      onClick={() => {
                        flyTo(p);
                        select(p);
                      }}
                    >
                      <span className="brain-space-dot" style={{ background: colorOf(p.t) }} />
                      <span className="brain-space-result-label">{p.l}</span>
                      <span className="brain-space-result-group">{p.t}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="brain-space-chips">
            {groupCounts.map(([g, n]) => (
              <button
                key={g}
                className={`brain-space-chip ${hidden.has(g) ? 'brain-space-chip--off' : ''}`}
                onClick={() => toggleGroup(g)}
                title={hidden.has(g) ? `Show ${g}` : `Hide ${g}`}
              >
                <span className="brain-space-dot" style={{ background: colorOf(g) }} />
                {g} <span className="brain-space-chip-n">{n}</span>
              </button>
            ))}
            {topTags.length > 0 && (
              <select
                className="brain-space-select"
                value={tag}
                onChange={(e) => setTag(e.target.value)}
                aria-label="Filter by tag"
              >
                <option value="">All tags</option>
                {topTags.map(([t, n]) => (
                  <option key={t} value={t}>
                    {t} ({n})
                  </option>
                ))}
              </select>
            )}
            <button className="brain-space-chip" onClick={() => fit(true)} title="Fit all points">
              Fit
            </button>
          </div>
        </div>
      )}

      {selPoint && !selPoint.n && (
        <aside className="brain-space-detail">
          <button className="brain-space-detail-close" onClick={() => select(null)} aria-label="Close">
            ×
          </button>
          <div className="brain-space-detail-type">
            <span className="brain-space-dot" style={{ background: colorOf(selPoint.t) }} />
            {selPoint.t}
            {selPoint.s ? ` · ${selPoint.s}` : ''}
          </div>
          <div className="brain-space-detail-title">{selPoint.l}</div>
          {selPoint.d && <p className="brain-space-detail-desc">{selPoint.d}</p>}
          {selPoint.g.length > 0 && (
            <div className="brain-space-detail-tags">
              {selPoint.g.slice(0, 8).map((t) => (
                <span key={t} className="brain-space-chip-n">#{t}</span>
              ))}
            </div>
          )}
          <div className="brain-space-detail-path">{selPoint.p}</div>
        </aside>
      )}

      {hoverNode && hoverPos && (
        <div
          className="brain-space-tip"
          style={{ left: Math.min(hoverPos.x + 14, Math.max(0, size.w - 260)), top: hoverPos.y + 14 }}
        >
          <div className="brain-space-tip-title">{hoverNode.label}</div>
          <div className="brain-space-tip-meta">
            {hoverNode.group}
            {hoverNode.meta.status ? ` · ${hoverNode.meta.status}` : ''}
          </div>
          {hoverNode.meta.description && <div className="brain-space-tip-desc">{hoverNode.meta.description}</div>}
        </div>
      )}

      {query.trim() && recall.isFetching && results.length === 0 && (
        <div className="brain-space-hint">Searching…</div>
      )}
      {pending && <div className="brain-space-note">Laying out the meaning space…</div>}
      {error && <div className="brain-space-note">Couldn’t build the space: {String(error)}</div>}
      {unavailable && (
        <div className="brain-space-note">
          {unavailable.reason === 'no_embeddings'
            ? 'No embedding index yet. Build it from Settings → Hybrid recall, then this view fills in. The Links tab works meanwhile.'
            : 'Too few embedded notes to lay out a space yet.'}
        </div>
      )}
      {space?.state === 'ready' && placed.length > 0 && visible.length === 0 && (
        <div className="brain-space-note">Nothing matches the current filters.</div>
      )}
    </div>
  );
}
