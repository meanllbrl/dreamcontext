import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import {
  useFederationGraph,
  useCreateConnection,
  useRemoveLauncherConnection,
  useToggleShareable,
  useUpdateProject,
  type VaultStatus,
  type FederationConnection,
} from '../hooks/useLauncher';
import './LauncherGraph.css';

// ─── Excalidraw house palette (pastel card + ink outline), used on the canvas ──
const INK = '#1f2430';
const READ = '#6741d9'; // violet — a live "reads" wire (the only wire kind)
const READ_SOFT = 'rgba(103,65,217,0.9)';
const CARD = {
  ok: { fill: '#b2f2bb', stroke: '#2f9e44' }, // green — up to date
  stale: { fill: '#ffec99', stroke: '#f08c00' }, // yellow — needs `dreamcontext update`
  gone: { fill: '#ffc9c9', stroke: '#e03131' }, // red — folder deleted
};

function cardStyle(n: VaultStatus): { fill: string; stroke: string } {
  if (!n.exists) return CARD.gone;
  if (n.needsUpdate) return CARD.stale;
  return CARD.ok;
}

// Read-only federation: the only wire kind is a live read. (`sync` is parked on
// the roadmap; reintroduce a member here if/when a copy/mirror mode is designed.)
type WireKind = 'reads';

interface GNode extends VaultStatus {
  id: string;
  x?: number;
  y?: number;
  __hw?: number;
  __hh?: number;
}

/** One ordered relationship between two vaults (the model the panel reads). */
interface Rel {
  from: string;
  to: string;
  kind: WireKind;
  /** reads: target is Readable (shareable). sync: always true (consented). */
  active: boolean;
}

interface GLink {
  source: string | GNode;
  target: string | GNode;
  kind: WireKind;
  active: boolean;
  twoWay: boolean;
  /** Bow so reads/sync and opposite directions never lie on top of each other. */
  curv: number;
}

function endId(end: string | GNode): string {
  return typeof end === 'string' ? end : end.id;
}

const TAP_SLOP = 6;

// ─── Canvas drawing helpers (graph-space) ─────────────────────────────────────
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function rectExit(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number) {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy);
  return { x: cx + dx * t, y: cy + dy * t };
}

function arrowHead(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  angle: number,
  size: number,
  color: string,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, -size * 0.5);
  ctx.lineTo(-size, size * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * The interactive cross-project federation board (Excalidraw-style). Every vault
 * is a rounded card; a single kind of wire connects them:
 *   • **reads** (violet): A→B = A reads B's CANONICAL memory LIVE during recall —
 *     a reference, never a copy. The target must be Readable (shareable) for the
 *     wire to be active; otherwise it is stored but inert.
 * Click source → target (or drag) to wire a read. (Copy-based sync is parked on
 * the roadmap — federation is read-only.)
 */
export function LauncherGraph() {
  const { data, isLoading, isError, error } = useFederationGraph();
  const createConn = useCreateConnection();
  const removeConn = useRemoveLauncherConnection();
  const toggleShareable = useToggleShareable();
  const updateProject = useUpdateProject();

  const fgRef = useRef<any>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [connectMode, setConnectMode] = useState(true);
  const [selected, setSelected] = useState<GNode | null>(null);
  const [actionNote, setActionNote] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(true);

  const dragSource = useRef<GNode | null>(null);
  const downPos = useRef<{ x: number; y: number } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const [pendingSource, setPendingSource] = useState<GNode | null>(null);
  const [showConns, setShowConns] = useState(false);
  const pendingRef = useRef<GNode | null>(null);
  pendingRef.current = pendingSource;
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  hoverRef.current = hoverTarget;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Derive the ordered read relationships from raw per-vault connection
  // directions. Read-only federation: every qualifying out/both edge becomes a
  // live READS wire; `active` = the target is Readable (shareable).
  const rels = useMemo<Rel[]>(() => {
    const nodes = data?.nodes ?? [];
    const conns: FederationConnection[] = data?.connections ?? [];
    const present = new Set(nodes.map((n) => n.name));
    const shareable = new Map(nodes.map((n) => [n.name, n.shareable]));
    const dir = new Map<string, 'out' | 'in' | 'both'>();
    for (const c of conns) dir.set(`${c.from}${c.to}`, c.direction);
    const hasOut = (a: string, b: string) => {
      const d = dir.get(`${a}${b}`);
      return d === 'out' || d === 'both';
    };
    const out: Rel[] = [];
    for (const c of conns) {
      if (!present.has(c.from) || !present.has(c.to)) continue;
      if (!hasOut(c.from, c.to)) continue;
      // B (=c.to) listens to A (=c.from) when B accepts A's digest.
      out.push({ from: c.from, to: c.to, kind: 'reads', active: shareable.get(c.to) === true });
    }
    return out;
  }, [data]);

  // Collapse reciprocal SAME-kind relationships into one two-way wire.
  const graphData = useMemo(() => {
    const nodes: GNode[] = (data?.nodes ?? []).map((n) => ({ ...n, id: n.name }));
    const relKey = (r: Rel) => `${r.from}${r.to}${r.kind}`;
    const byKey = new Map(rels.map((r) => [relKey(r), r]));
    const links: GLink[] = [];
    const done = new Set<string>();
    for (const r of rels) {
      const pairKey = [r.from, r.to].sort().join('') + '' + r.kind;
      if (done.has(pairKey)) continue;
      done.add(pairKey);
      const rev = byKey.get(`${r.to}${r.from}${r.kind}`);
      links.push({
        source: r.from,
        target: r.to,
        kind: r.kind,
        active: r.active || (rev?.active ?? false),
        twoWay: !!rev,
        // Opposite directions bow opposite ways so reciprocal wires don't overlap.
        curv: (r.from < r.to ? 1 : -1) * 0.13,
      });
    }
    return { nodes, links };
  }, [data, rels]);

  const nodeById = useMemo(() => {
    const m = new Map<string, GNode>();
    for (const n of graphData.nodes) m.set(n.id, n);
    return m;
  }, [graphData]);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.d3Force('charge')?.strength(-900);
    fg.d3Force('link')?.distance(230);
    fg.d3ReheatSimulation?.();
  }, [graphData]);

  const fitView = useCallback(() => {
    const fg = fgRef.current;
    if (!fg) return;
    fg.zoomToFit(500, 140);
    window.setTimeout(() => {
      try {
        if (fg.zoom() > 1.4) fg.zoom(1.4, 350);
      } catch {
        /* not ready before first paint */
      }
    }, 540);
  }, []);

  // On-canvas zoom controls. Work in BOTH Connect and View modes (the library's
  // wheel-zoom is disabled while connecting so drag-to-connect owns the gesture —
  // these buttons drive `fg.zoom()` directly so users can always zoom). Clamped
  // to a sane range so a node never disappears off the edge of usefulness.
  const ZOOM_MIN = 0.15;
  const ZOOM_MAX = 6;
  const zoomBy = useCallback((factor: number) => {
    const fg = fgRef.current;
    if (!fg) return;
    let z = 1;
    try {
      z = fg.zoom() as number;
    } catch {
      /* default 1 before first paint */
    }
    const next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z * factor));
    fg.zoom(next, 220);
  }, []);
  const zoomIn = useCallback(() => zoomBy(1.3), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy(1 / 1.3), [zoomBy]);

  const nodeAtScreen = useCallback(
    (sx: number, sy: number): GNode | null => {
      const fg = fgRef.current;
      if (!fg) return null;
      let z = 1;
      try {
        z = fg.zoom() as number;
      } catch {
        /* default 1 */
      }
      for (const n of graphData.nodes) {
        if (n.x == null || n.y == null) continue;
        const p = fg.graph2ScreenCoords(n.x, n.y);
        const hw = (n.__hw ?? 50) * z + 4;
        const hh = (n.__hh ?? 16) * z + 4;
        if (Math.abs(p.x - sx) <= hw && Math.abs(p.y - sy) <= hh) return n;
      }
      return null;
    },
    [graphData],
  );

  // Hit-test the nearest wire (sampling its curve) within a screen radius — so a
  // click ON the line removes it, in any mode (the library's own link hit-area
  // is a thin curve and easy to miss).
  const linkAtScreen = useCallback(
    (sx: number, sy: number): GLink | null => {
      const fg = fgRef.current;
      if (!fg) return null;
      let best: GLink | null = null;
      let bestD = 14; // px
      for (const l of graphData.links) {
        const s = l.source as GNode;
        const t = l.target as GNode;
        if (s.x == null || s.y == null || t.x == null || t.y == null) continue;
        const dist = Math.hypot(t.x - s.x, t.y - s.y) || 1;
        const mx0 = (s.x + t.x) / 2;
        const my0 = (s.y + t.y) / 2;
        const pang = Math.atan2(t.y - s.y, t.x - s.x) + Math.PI / 2;
        const cpx = mx0 + Math.cos(pang) * l.curv * dist;
        const cpy = my0 + Math.sin(pang) * l.curv * dist;
        const sE = rectExit(s.x, s.y, (s.__hw ?? 50) + 2, (s.__hh ?? 16) + 2, cpx, cpy);
        const tE = rectExit(t.x, t.y, (t.__hw ?? 50) + 2, (t.__hh ?? 16) + 2, cpx, cpy);
        for (let k = 0; k <= 14; k++) {
          const u = k / 14;
          const bx = (1 - u) * (1 - u) * sE.x + 2 * (1 - u) * u * cpx + u * u * tE.x;
          const by = (1 - u) * (1 - u) * sE.y + 2 * (1 - u) * u * cpy + u * u * tE.y;
          const p = fg.graph2ScreenCoords(bx, by);
          const d = Math.hypot(p.x - sx, p.y - sy);
          if (d < bestD) {
            bestD = d;
            best = l;
          }
        }
      }
      return best;
    },
    [graphData],
  );

  function relCoords(e: React.PointerEvent): { x: number; y: number } {
    const rect = wrapRef.current?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }

  const wire = useCallback(
    (src: GNode, dst: GNode) => {
      setActionNote(null);
      createConn.mutate(
        { from: src.id, to: dst.id },
        {
          onSuccess: () => {
            if (!dst.shareable) {
              setActionNote(
                `“${src.name}” now reads “${dst.name}”, but “${dst.name}” isn't Readable yet — click it and turn on Readable so the wire goes live.`,
              );
              setSelected(dst);
            }
          },
          onError: (err) =>
            setActionNote(err instanceof Error ? err.message : 'Failed to connect.'),
        },
      );
    },
    [createConn],
  );

  function onPointerDown(e: React.PointerEvent) {
    const { x, y } = relCoords(e);
    pointer.current = { x, y };
    downPos.current = { x, y }; // always — needed for tap-vs-drag in both modes
    if (!connectMode) return; // View mode: let the library own pan/zoom/click
    fgRef.current?.resumeAnimation?.();
    const src = nodeAtScreen(x, y);
    if (src) {
      dragSource.current = src;
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    } else if (pendingSource) {
      setPendingSource(null);
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if (!connectMode) return;
    const { x, y } = relCoords(e);
    pointer.current = { x, y };
    const anchor = dragSource.current ?? pendingRef.current;
    if (!anchor) {
      if (hoverRef.current) setHoverTarget(null);
      return;
    }
    const over = nodeAtScreen(x, y);
    const next = over && over.id !== anchor.id ? over.id : null;
    if (next !== hoverRef.current) setHoverTarget(next);
  }

  function onPointerUp(e: React.PointerEvent) {
    const { x, y } = relCoords(e);
    const moved =
      downPos.current != null &&
      Math.hypot(x - downPos.current.x, y - downPos.current.y) > TAP_SLOP;
    downPos.current = null;
    const upNode = nodeAtScreen(x, y);

    // A tap on a wire (not on a node) removes it — works in BOTH modes.
    if (!moved && !upNode) {
      const hit = linkAtScreen(x, y);
      if (hit) {
        handleLinkClick(hit);
        pointer.current = null;
        return;
      }
    }

    if (!connectMode) {
      pointer.current = null;
      return;
    }

    const src = dragSource.current;
    dragSource.current = null;
    setHoverTarget(null);
    const armed = pendingRef.current;

    if (src && moved && upNode && upNode.id !== src.id) {
      wire(src, upNode);
      setPendingSource(null);
      pointer.current = null;
      return;
    }
    if (src && !moved && upNode && upNode.id === src.id) {
      if (armed && armed.id !== src.id) {
        wire(armed, src);
        setPendingSource(null);
        pointer.current = null;
        return;
      }
      if (armed && armed.id === src.id) {
        setPendingSource(null);
        pointer.current = null;
        return;
      }
      setPendingSource(src);
      return;
    }
    pointer.current = null;
  }

  function onRenderFramePost(ctx: CanvasRenderingContext2D) {
    const anchor = dragSource.current ?? pendingRef.current;
    const fg = fgRef.current;
    if (!anchor || !pointer.current || !fg || anchor.x == null || anchor.y == null) return;
    const p = fg.screen2GraphCoords(pointer.current.x, pointer.current.y);
    ctx.save();
    ctx.strokeStyle = READ;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.restore();
  }

  function handleNodeClick(n: GNode) {
    if (connectMode) return;
    setSelected(n);
    setActionNote(null);
  }

  function handleLinkClick(l: GLink) {
    const from = endId(l.source);
    const to = endId(l.target);
    const fromName = nodeById.get(from)?.name ?? from;
    const toName = nodeById.get(to)?.name ?? to;
    if (!window.confirm(`Remove the read “${fromName}” → “${toName}”?`)) return;
    removeConn.mutate({ from, to });
    if (l.twoWay) removeConn.mutate({ from: to, to: from });
  }

  // Plain-language label + direct (no-confirm) removal for the always-on list.
  function linkLabel(l: GLink): string {
    const from = nodeById.get(endId(l.source))?.name ?? endId(l.source);
    const to = nodeById.get(endId(l.target))?.name ?? endId(l.target);
    return l.twoWay
      ? `${from} ⇄ ${to} — read each other`
      : `${from} reads ${to}${l.active ? '' : ' — not Readable yet'}`;
  }

  function removeLink(l: GLink) {
    const from = endId(l.source);
    const to = endId(l.target);
    removeConn.mutate({ from, to });
    if (l.twoWay) removeConn.mutate({ from: to, to: from });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') {
        if (pendingRef.current) setPendingSource(null);
        else if (showGuide) setShowGuide(false);
        else if (selected) setSelected(null);
        dragSource.current = null;
        pointer.current = null;
        setHoverTarget(null);
      } else if (e.key === 'c' || e.key === 'C') {
        setConnectMode((v) => !v);
      } else if (e.key === '?') {
        setShowGuide(true);
      } else if (e.key === '+' || e.key === '=') {
        zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        zoomOut();
      } else if (e.key === '0') {
        fitView();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showGuide, selected, zoomIn, zoomOut, fitView]);

  const vaults = data?.nodes ?? [];
  const hasLinks = graphData.links.length > 0;

  // Plain-language relationships for the selected node (the clarity anchor).
  const selectedRels = useMemo(() => {
    if (!selected) return [];
    const out: { text: string; onRemove: () => void }[] = [];
    for (const r of rels) {
      if (r.from !== selected.id && r.to !== selected.id) continue;
      if (r.from === selected.id)
        out.push({
          text: `You read “${r.to}” live${r.active ? '' : ' — not Readable yet'}`,
          onRemove: () => removeConn.mutate({ from: r.from, to: r.to }),
        });
      else
        out.push({
          text: `“${r.from}” reads you live`,
          onRemove: () => removeConn.mutate({ from: r.from, to: r.to }),
        });
    }
    return out;
  }, [selected, rels, removeConn]);

  return (
    <div className="lgraph">
      <div className="lgraph-toolbar">
        <button
          type="button"
          className={`lgraph-mode${connectMode ? ' lgraph-mode--on' : ''}`}
          onClick={() => setConnectMode((v) => !v)}
          title="Toggle Connect mode (C)"
        >
          <span className="lgraph-mode-dot" aria-hidden />
          {connectMode ? 'Connect mode' : 'View mode'}
        </button>
        <button type="button" className="lgraph-help" onClick={() => setShowGuide(true)}>
          How it works
        </button>
        <button
          type="button"
          className={`lgraph-help${showConns ? ' lgraph-help--on' : ''}`}
          onClick={() => setShowConns((v) => !v)}
        >
          Connections{graphData.links.length ? ` (${graphData.links.length})` : ''}
        </button>
        <span className="lgraph-hint">
          {connectMode
            ? pendingSource
              ? `Now click the project “${pendingSource.name}” should read.`
              : 'Click a project then the one it should read — or drag. Click a wire (or use Connections) to remove it.'
            : 'View mode — click a wire to remove it, or click a project for details. Press C to connect.'}
        </span>
        <span className="lgraph-legend">
          <span className="lgraph-legend-group">
            <i className="lgwire lgwire--read" /> reads (live reference — nothing copied)
            <i className="lgwire lgwire--inert" /> not readable yet
          </span>
        </span>
      </div>

      {actionNote && (
        <div className="lgraph-note">
          <span>{actionNote}</span>
          <button className="lgraph-note-x" onClick={() => setActionNote(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div
        className="lgraph-canvas"
        ref={wrapRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {isLoading && <div className="lgraph-status">Loading network…</div>}
        {isError && (
          <div className="lgraph-status lgraph-status--err">
            {error instanceof Error ? error.message : 'Failed to load the network.'}
          </div>
        )}
        {!isLoading && !isError && vaults.length < 2 && (
          <div className="lgraph-status">
            Add at least two projects to start wiring relationships between them.
          </div>
        )}

        {vaults.length >= 2 && (
          // On-canvas zoom controls — work in both Connect and View modes.
          // `onPointerDown` stops propagation so a click on a control never
          // starts a drag-to-connect gesture on the canvas wrapper below.
          <div
            className="lgraph-zoom"
            role="group"
            aria-label="Zoom controls"
            onPointerDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="lgraph-zoom-btn"
              onClick={zoomIn}
              aria-label="Zoom in"
              title="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              className="lgraph-zoom-btn"
              onClick={zoomOut}
              aria-label="Zoom out"
              title="Zoom out"
            >
              −
            </button>
            <button
              type="button"
              className="lgraph-zoom-btn lgraph-zoom-fit"
              onClick={fitView}
              aria-label="Fit graph to view"
              title="Fit to view"
            >
              ⤢
            </button>
          </div>
        )}

        {dims.w > 0 && vaults.length >= 2 && (
          <ForceGraph2D<GNode, GLink>
            ref={fgRef}
            graphData={graphData}
            width={dims.w}
            height={dims.h}
            backgroundColor="#0b0b12"
            nodeId="id"
            nodeRelSize={6}
            // Pan is disabled in Connect mode so a press-drag on empty canvas
            // arms a wire instead of scrolling the board. Wheel-zoom, however,
            // is a separate gesture that never conflicts with drag-to-connect,
            // so we keep it enabled in BOTH modes — together with the explicit
            // +/−/fit buttons, the user can always zoom.
            enablePanInteraction={!connectMode}
            enableZoomInteraction={true}
            // Never drag nodes: in View mode a node-drag would swallow the click
            // so the detail panel (where you delete connections) never opens.
            enableNodeDrag={false}
            cooldownTicks={140}
            onEngineStop={fitView}
            onNodeClick={(n: GNode) => handleNodeClick(n)}
            onRenderFramePost={onRenderFramePost}
            linkColor={() => 'rgba(0,0,0,0)'}
            linkDirectionalArrowLength={0}
            linkCurvature={(l: GLink) => l.curv}
            linkDirectionalParticles={(l: GLink) => (l.active ? 3 : 0)}
            linkDirectionalParticleSpeed={0.006}
            linkDirectionalParticleWidth={3.4}
            linkDirectionalParticleColor={() => '#c9b8ff'}
            linkCanvasObjectMode={() => 'replace'}
            linkCanvasObject={(l: GLink, ctx: CanvasRenderingContext2D, scale: number) => {
              const s = l.source as GNode;
              const t = l.target as GNode;
              if (s.x == null || s.y == null || t.x == null || t.y == null) return;
              // Quadratic bow matching the library's linkCurvature, so the drawn
              // wire and its flowing particles ride the SAME arc (and reads/sync
              // never overlap). Control point = midpoint offset perpendicular.
              const dist = Math.hypot(t.x - s.x, t.y - s.y) || 1;
              const mx0 = (s.x + t.x) / 2;
              const my0 = (s.y + t.y) / 2;
              const pang = Math.atan2(t.y - s.y, t.x - s.x) + Math.PI / 2;
              const cpx = mx0 + Math.cos(pang) * l.curv * dist;
              const cpy = my0 + Math.sin(pang) * l.curv * dist;
              // Clip endpoints to card edges along the tangent toward the control.
              const sE = rectExit(s.x, s.y, (s.__hw ?? 50) + 2, (s.__hh ?? 16) + 2, cpx, cpy);
              const tE = rectExit(t.x, t.y, (t.__hw ?? 50) + 2, (t.__hh ?? 16) + 2, cpx, cpy);
              const sx = sE.x;
              const sy = sE.y;
              const tx = tE.x;
              const ty = tE.y;
              const angT = Math.atan2(ty - cpy, tx - cpx); // tangent into target
              const angS = Math.atan2(sy - cpy, sx - cpx); // tangent into source

              // Read-only federation: every wire is a live READS wire.
              ctx.save();
              ctx.lineCap = 'round';
              if (l.active) {
                ctx.strokeStyle = READ_SOFT;
                ctx.lineWidth = 2.2;
                ctx.setLineDash([]);
              } else {
                ctx.strokeStyle = 'rgba(150,150,170,0.55)';
                ctx.lineWidth = 1.6;
                ctx.setLineDash([5, 5]);
              }
              ctx.beginPath();
              ctx.moveTo(sx, sy);
              ctx.quadraticCurveTo(cpx, cpy, tx, ty);
              ctx.stroke();
              ctx.setLineDash([]);

              const head = l.active ? READ : 'rgba(150,150,170,0.75)';
              arrowHead(ctx, tx, ty, angT, 7, head);
              if (l.twoWay) arrowHead(ctx, sx, sy, angS, 7, head);

              if (scale > 0.75) {
                // Label rides the curve apex (quadratic at t=0.5).
                const mx = 0.25 * sx + 0.5 * cpx + 0.25 * tx;
                const my = 0.25 * sy + 0.5 * cpy + 0.25 * ty;
                const fs = 8;
                ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, sans-serif`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                const label = l.twoWay ? 'read each other' : 'reads';
                const tw = ctx.measureText(label).width;
                ctx.fillStyle = '#0b0b12';
                roundRect(ctx, mx - tw / 2 - 3, my - fs / 2 - 2, tw + 6, fs + 4, 3);
                ctx.fill();
                ctx.fillStyle = '#c9b8ff';
                ctx.fillText(label, mx, my);
              }
              ctx.restore();
            }}
            nodeCanvasObject={(n: GNode, ctx: CanvasRenderingContext2D) => {
              const cx = n.x ?? 0;
              const cy = n.y ?? 0;
              const style = cardStyle(n);
              const isPending = pendingRef.current?.id === n.id;
              const isHover = hoverRef.current === n.id;
              const fs = 13;
              ctx.font = `600 ${fs}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
              const tw = ctx.measureText(n.name).width;
              const padX = 14;
              const padY = 9;
              const w = Math.min(220, Math.max(72, tw + padX * 2));
              const h = fs + padY * 2;
              n.__hw = w / 2;
              n.__hh = h / 2;
              const x = cx - w / 2;
              const y = cy - h / 2;

              ctx.save();
              ctx.shadowColor = 'rgba(0,0,0,0.45)';
              ctx.shadowBlur = 10;
              ctx.shadowOffsetY = 3;
              roundRect(ctx, x, y, w, h, 9);
              ctx.fillStyle = style.fill;
              ctx.fill();
              ctx.restore();

              roundRect(ctx, x, y, w, h, 9);
              if (isPending || isHover) {
                ctx.strokeStyle = READ;
                ctx.lineWidth = 2.4;
              } else {
                ctx.strokeStyle = style.stroke;
                ctx.lineWidth = 1.6;
              }
              ctx.stroke();

              // Shareable: a violet "Readable" pip on the top-right corner.
              if (n.shareable) {
                ctx.beginPath();
                ctx.arc(x + w - 7, y + 7, 3.2, 0, 2 * Math.PI);
                ctx.fillStyle = READ;
                ctx.fill();
                ctx.lineWidth = 1.2;
                ctx.strokeStyle = '#0b0b12';
                ctx.stroke();
              }

              ctx.fillStyle = INK;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              const label = tw > w - padX * 2 ? truncate(ctx, n.name, w - padX * 2) : n.name;
              ctx.fillText(label, cx, cy + 0.5);
            }}
            nodePointerAreaPaint={(n: GNode, color: string, ctx: CanvasRenderingContext2D) => {
              const w = (n.__hw ?? 50) * 2;
              const h = (n.__hh ?? 16) * 2;
              roundRect(ctx, (n.x ?? 0) - w / 2, (n.y ?? 0) - h / 2, w, h, 9);
              ctx.fillStyle = color;
              ctx.fill();
            }}
          />
        )}

        {showGuide && vaults.length >= 2 && (
          <GraphGuide hasLinks={hasLinks} onClose={() => setShowGuide(false)} />
        )}

        {showConns && (
          <div className="lgraph-conns" role="dialog" aria-label="All connections">
            <div className="lgraph-conns-head">
              <strong>All connections</strong>
              <button className="lgraph-x" onClick={() => setShowConns(false)} aria-label="Close">
                ✕
              </button>
            </div>
            {graphData.links.length === 0 ? (
              <div className="lgraph-conns-empty">
                No connections yet. Switch on Connect mode and draw a wire.
              </div>
            ) : (
              graphData.links.map((l, i) => (
                <div className="lgraph-conn-row" key={i}>
                  <span className={`lgchip-wire lgchip-wire--${l.kind}`} aria-hidden />
                  <span className="lgraph-conn-label">{linkLabel(l)}</span>
                  <button
                    className="lgraph-conn-del"
                    onClick={() => removeLink(l)}
                    aria-label="Delete connection"
                    title="Delete"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {selected && (
        <div className="lgraph-detail">
          <div className="lgraph-detail-head">
            <span
              className="lgchip"
              style={{ background: cardStyle(selected).fill, borderColor: cardStyle(selected).stroke }}
            />
            <strong>{selected.name}</strong>
            <button className="lgraph-x" onClick={() => setSelected(null)} aria-label="Close">
              ✕
            </button>
          </div>
          <div className="lgraph-detail-path">{selected.path}</div>
          <div className="lgraph-detail-row">
            <span>
              {!selected.exists
                ? 'Folder is gone.'
                : selected.needsUpdate
                  ? `Behind: v${selected.setupVersion} → v${selected.latestVersion}`
                  : `Up to date (v${selected.setupVersion})`}
            </span>
            {selected.exists && selected.needsUpdate && (
              <button
                className="lgraph-btn"
                disabled={updateProject.isPending}
                onClick={() => updateProject.mutate(selected.name)}
              >
                {updateProject.isPending ? 'Updating…' : 'Update'}
              </button>
            )}
          </div>
          <label className="lgraph-detail-row lgraph-share">
            <input
              type="checkbox"
              checked={selected.shareable}
              disabled={!selected.exists || toggleShareable.isPending}
              onChange={(e) =>
                toggleShareable.mutate(
                  { name: selected.name, shareable: e.target.checked },
                  { onSuccess: () => setSelected({ ...selected, shareable: e.target.checked }) },
                )
              }
            />
            <span>Readable — let any connected project read this one</span>
          </label>

          <div className="lgraph-rels">
            <div className="lgraph-rels-title">Connections</div>
            {selectedRels.length === 0 && (
              <div className="lgraph-rels-empty">No connections yet.</div>
            )}
            {selectedRels.map((r, i) => (
              <div className="lgraph-rel" key={i}>
                <span>{r.text}</span>
                <button className="lgraph-rel-x" onClick={r.onRemove} aria-label="Remove">
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function truncate(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  let s = text;
  while (s.length > 1 && ctx.measureText(s + '…').width > maxW) s = s.slice(0, -1);
  return s.length < text.length ? s + '…' : text;
}

/** Illustrated explainer: reads vs sync, with a live mini diagram. */
function GraphGuide({ hasLinks, onClose }: { hasLinks: boolean; onClose: () => void }) {
  return (
    <div className="lgraph-guide" role="dialog" aria-label="How the network works">
      <button className="lgraph-guide-x" onClick={onClose} aria-label="Close">
        ✕
      </button>
      <h3 className="lgraph-guide-title">How reading works</h3>

      <div className="lgraph-guide-demo" aria-hidden>
        <svg viewBox="0 0 260 60" className="lgraph-guide-svg">
          {/* reads */}
          <line className="lgraph-guide-flow" x1="92" y1="30" x2="168" y2="30" stroke="#6741d9" strokeWidth="2.4" />
          <polygon points="168,26 176,30 168,34" fill="#6741d9" />
          <rect x="14" y="16" width="70" height="28" rx="8" fill="#b2f2bb" stroke="#2f9e44" strokeWidth="1.6" />
          <text x="49" y="31" textAnchor="middle" className="lgraph-guide-cardlabel">App</text>
          <rect x="176" y="16" width="70" height="28" rx="8" fill="#b2f2bb" stroke="#2f9e44" strokeWidth="1.6" />
          <circle cx="240" cy="20" r="3.2" fill="#6741d9" stroke="#0b0b12" strokeWidth="1" />
          <text x="211" y="31" textAnchor="middle" className="lgraph-guide-cardlabel">Libs</text>
          <text x="130" y="23" textAnchor="middle" className="lgraph-guide-wirelabel" fill="#b9a6ff">reads</text>
        </svg>
      </div>

      <ul className="lgraph-guide-defs">
        <li>
          <span className="lgraph-key lgraph-key--read" /> <strong>Reads (violet):</strong> App reads
          Libs' <em>canonical</em> memory <em>live</em> during recall — a reference, never a copy.
          Each project stays the single source of truth for its own knowledge. The target must be
          Readable (violet pip), or the wire is stored but inert.
        </li>
      </ul>

      <p className="lgraph-guide-foot">
        Click a project then the one it should read (or drag). Click any project to see exactly who
        reads it. (Copy-based sync is parked on the roadmap — federation only reads, live.)
      </p>

      <button className="lgraph-guide-cta" onClick={onClose}>
        {hasLinks ? 'Got it' : 'Start wiring'}
      </button>
    </div>
  );
}
