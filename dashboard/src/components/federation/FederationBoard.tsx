import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { useI18n } from '../../context/I18nContext';
import {
  useFederationGraph,
  useCreateConnection,
  useRemoveLauncherConnection,
  useToggleShareable,
  useUpdateProject,
  type VaultStatus,
  type FederationConnection,
} from '../../hooks/useLauncher';
import './FederationBoard.css';

// ─── Excalidraw house palette (pastel card + ink outline), used on the canvas.
// Canvas 2D can't read CSS custom properties, so these hexes are the tokens for
// everything drawn on the board; FederationBoard.css mirrors them for legends. ──
const INK = '#1f2430';
const READ = '#6741d9'; // violet — a live "reads" wire (the only wire kind)
const READ_SOFT = 'rgba(103,65,217,0.9)';
const SELECT = '#c9b8ff'; // selection ring around the inspected card
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

/** One ordered relationship between two vaults (the model the panels read). */
interface Rel {
  from: string;
  to: string;
  kind: WireKind;
  /** reads: target is Readable (shareable) → the wire is live. */
  active: boolean;
}

interface GLink {
  source: string | GNode;
  target: string | GNode;
  kind: WireKind;
  active: boolean;
  twoWay: boolean;
  /** Bow so opposite directions never lie on top of each other. */
  curv: number;
}

/** In-place editor for a clicked wire (positioned at the click point). */
interface WireMenu {
  a: string;
  b: string;
  x: number;
  y: number;
}

/** Feedback banner above the board. Success notes auto-dismiss. */
interface Note {
  kind: 'success' | 'warn' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

function endId(end: string | GNode): string {
  return typeof end === 'string' ? end : end.id;
}

function linkPairKey(l: GLink): string {
  return `${endId(l.source)}|${endId(l.target)}`;
}

/** Tiny interpolation for i18n templates: fmt('“{from}” reads “{to}”', {...}). */
function fmt(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? `{${k}}`);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
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
 *
 * One modeless interaction model (no Connect/View toggle):
 *   • drag from a card onto another card → wire a read
 *   • click a card → inspect it (detail panel; can arm click-to-connect)
 *   • click a wire → in-place editor (remove per direction, or make the target
 *     Readable when the wire is inert)
 *   • drag empty canvas → pan; wheel / buttons → zoom
 *
 * Reusable widget: the Launcher mounts it full-screen (`variant="full"`, the
 * default) and the per-project Settings → Connections panel mounts it inside a
 * bounded card (`variant="embedded"`). It is fully self-contained — it drives the
 * cross-project (vault-agnostic) `/api/launcher/*` endpoints, so it behaves
 * identically wherever it is mounted.
 */
export interface FederationBoardProps {
  /** `full` fills its flex parent (Launcher board); `embedded` is a fixed-height card (Settings). */
  variant?: 'full' | 'embedded';
}

export function FederationBoard({ variant = 'full' }: FederationBoardProps = {}) {
  const embedded = variant === 'embedded';
  const { t } = useI18n();
  const { data, isLoading, isError, error } = useFederationGraph();
  const createConn = useCreateConnection();
  const removeConn = useRemoveLauncherConnection();
  const toggleShareable = useToggleShareable();
  const updateProject = useUpdateProject();

  const fgRef = useRef<any>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [selected, setSelected] = useState<GNode | null>(null);
  const selectedRef = useRef<GNode | null>(null);
  selectedRef.current = selected;
  const [note, setNote] = useState<Note | null>(null);
  // In the bounded Settings card the guide overlay would blanket the small board,
  // so it starts closed there (still reachable via the "How it works" button);
  // full-screen in the Launcher it opens by default to teach the interaction.
  const [showGuide, setShowGuide] = useState(!embedded);
  const [showConns, setShowConns] = useState(false);
  const [wireMenu, setWireMenu] = useState<WireMenu | null>(null);

  const dragSource = useRef<GNode | null>(null);
  const [dragging, setDragging] = useState(false); // cursor feedback only
  const downPos = useRef<{ x: number; y: number } | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  // "Armed" click-to-connect source (set from the detail panel's Connect button).
  const [pendingSource, setPendingSource] = useState<GNode | null>(null);
  const pendingRef = useRef<GNode | null>(null);
  pendingRef.current = pendingSource;
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const hoverRef = useRef<string | null>(null);
  hoverRef.current = hoverTarget;
  const [hoverLink, setHoverLink] = useState<string | null>(null);
  const hoverLinkRef = useRef<string | null>(null);
  hoverLinkRef.current = hoverLink;

  const reducedMotion = useMemo(
    () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    [],
  );

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Success notes auto-dismiss; warnings/errors stay until acted on or closed.
  useEffect(() => {
    if (!note || note.kind !== 'success') return;
    const id = window.setTimeout(() => setNote(null), 4500);
    return () => window.clearTimeout(id);
  }, [note]);

  // Derive the ordered read relationships from raw per-vault connection
  // directions. Read-only federation: every qualifying out/both edge becomes a
  // live READS wire; `active` = the target is Readable (shareable).
  const rels = useMemo<Rel[]>(() => {
    const nodes = data?.nodes ?? [];
    const conns: FederationConnection[] = data?.connections ?? [];
    const present = new Set(nodes.map((n) => n.name));
    const shareable = new Map(nodes.map((n) => [n.name, n.shareable]));
    const dir = new Map<string, 'out' | 'in' | 'both'>();
    for (const c of conns) dir.set(`${c.from}→${c.to}`, c.direction);
    const hasOut = (a: string, b: string) => {
      const d = dir.get(`${a}→${b}`);
      return d === 'out' || d === 'both';
    };
    const out: Rel[] = [];
    for (const c of conns) {
      if (!present.has(c.from) || !present.has(c.to)) continue;
      if (!hasOut(c.from, c.to)) continue;
      out.push({ from: c.from, to: c.to, kind: 'reads', active: shareable.get(c.to) === true });
    }
    return out;
  }, [data]);

  // Collapse reciprocal SAME-kind relationships into one two-way wire.
  const graphData = useMemo(() => {
    const nodes: GNode[] = (data?.nodes ?? []).map((n) => ({ ...n, id: n.name }));
    const relKey = (r: Rel) => `${r.from}→${r.to}→${r.kind}`;
    const byKey = new Map(rels.map((r) => [relKey(r), r]));
    const links: GLink[] = [];
    const done = new Set<string>();
    for (const r of rels) {
      const pairKey = [r.from, r.to].sort().join('→') + '→' + r.kind;
      if (done.has(pairKey)) continue;
      done.add(pairKey);
      const rev = byKey.get(`${r.to}→${r.from}→${r.kind}`);
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

  const nameOf = useCallback((id: string) => nodeById.get(id)?.name ?? id, [nodeById]);

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

  // Auto-fit only once (first layout settle). Re-fitting after every wire
  // add/remove yanked the viewport around; the ⤢ button refits on demand.
  const didFit = useRef(false);
  const onEngineStop = useCallback(() => {
    if (didFit.current) return;
    didFit.current = true;
    fitView();
  }, [fitView]);

  // On-canvas zoom controls, clamped to a sane range so a card never disappears
  // off the edge of usefulness. Wheel-zoom stays enabled too — it never
  // conflicts with drag-to-connect (which only starts ON a card).
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
  // click ON the line opens its editor (the library's own link hit-area is a
  // thin curve and easy to miss).
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

  const makeReadable = useCallback(
    (id: string, name: string) => {
      toggleShareable.mutate(
        { name: id, shareable: true },
        {
          onSuccess: () => {
            setNote({ kind: 'success', text: fmt(t('federation.map.note.readable'), { name }) });
            setSelected((s) => (s && s.id === id ? { ...s, shareable: true } : s));
          },
          onError: (err) =>
            setNote({
              kind: 'error',
              text: err instanceof Error ? err.message : t('federation.map.note.failed'),
            }),
        },
      );
    },
    [toggleShareable, t],
  );

  const wire = useCallback(
    (src: GNode, dst: GNode) => {
      setNote(null);
      createConn.mutate(
        { from: src.id, to: dst.id },
        {
          onSuccess: () => {
            if (dst.shareable) {
              setNote({
                kind: 'success',
                text: fmt(t('federation.map.note.connected'), { from: src.name, to: dst.name }),
              });
            } else {
              // The one confusing state — the wire exists but is inert. Hand the
              // user the fix as a one-click action instead of prose instructions.
              setNote({
                kind: 'warn',
                text: fmt(t('federation.map.note.inert'), { from: src.name, to: dst.name }),
                action: {
                  label: t('federation.map.note.makeReadable'),
                  run: () => makeReadable(dst.id, dst.name),
                },
              });
            }
          },
          onError: (err) =>
            setNote({
              kind: 'error',
              text: err instanceof Error ? err.message : t('federation.map.note.failed'),
            }),
        },
      );
    },
    [createConn, makeReadable, t],
  );

  // ── Modeless pointer model on the canvas wrapper ──────────────────────────
  // Capture-phase down: a press ON a card is ours (tap = inspect, drag = wire) —
  // stopPropagation keeps d3-zoom's pan from fighting the gesture. A press on
  // empty canvas passes through untouched, so the library pans as usual.
  function onPointerDownCapture(e: React.PointerEvent) {
    if ((e.target as HTMLElement).tagName !== 'CANVAS') return; // overlay press — not ours
    const { x, y } = relCoords(e);
    pointer.current = { x, y };
    downPos.current = { x, y };
    const src = nodeAtScreen(x, y);
    if (src) {
      // Cancel the pointer event AND its compatibility mouse event: d3-zoom
      // pans on `mousedown`, so stopping only `pointerdown` would let the
      // library pan straight through the wire gesture.
      e.stopPropagation();
      e.preventDefault();
      dragSource.current = src;
      try {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
      } catch {
        /* synthetic pointers (tests) may not support capture */
      }
    }
  }

  // pointerdown (above) runs first; if it claimed a card press, swallow the
  // follow-up mousedown so d3-zoom never starts a pan for this gesture.
  function onMouseDownCapture(e: React.MouseEvent) {
    if (dragSource.current) {
      e.stopPropagation();
      e.preventDefault();
    }
  }

  function onPointerMove(e: React.PointerEvent) {
    if ((e.target as HTMLElement).tagName !== 'CANVAS' && !dragSource.current) {
      if (hoverRef.current) setHoverTarget(null);
      if (hoverLinkRef.current) setHoverLink(null);
      return;
    }
    const { x, y } = relCoords(e);
    pointer.current = { x, y };
    if (dragSource.current && downPos.current && !dragging) {
      if (Math.hypot(x - downPos.current.x, y - downPos.current.y) > TAP_SLOP) setDragging(true);
    }
    const over = nodeAtScreen(x, y);
    const anchor = dragSource.current ?? pendingRef.current;
    if (anchor) {
      // Wiring: highlight only a valid drop target (any card but the source).
      const next = over && over.id !== anchor.id ? over.id : null;
      if (next !== hoverRef.current) setHoverTarget(next);
      if (hoverLinkRef.current) setHoverLink(null);
      return;
    }
    // Plain hover affordances: ring the card / thicken the wire under the pointer.
    const nextNode = over?.id ?? null;
    if (nextNode !== hoverRef.current) setHoverTarget(nextNode);
    const link = over ? null : linkAtScreen(x, y);
    const key = link ? linkPairKey(link) : null;
    if (key !== hoverLinkRef.current) setHoverLink(key);
  }

  function onPointerUp(e: React.PointerEvent) {
    if (!downPos.current) return; // press didn't start on the canvas
    const { x, y } = relCoords(e);
    const moved = Math.hypot(x - downPos.current.x, y - downPos.current.y) > TAP_SLOP;
    downPos.current = null;
    setDragging(false);
    const src = dragSource.current;
    dragSource.current = null;
    setHoverTarget(null);
    const upNode = nodeAtScreen(x, y);
    const armed = pendingRef.current;

    // Drag from card A released on card B → A reads B.
    if (src && moved && upNode && upNode.id !== src.id) {
      wire(src, upNode);
      setPendingSource(null);
      return;
    }
    if (moved) return; // pan or aborted drag — nothing else to do

    if (upNode) {
      if (armed && armed.id !== upNode.id) {
        wire(armed, upNode); // click-to-connect finish
        setPendingSource(null);
        return;
      }
      if (armed && armed.id === upNode.id) {
        setPendingSource(null); // clicked the armed card again — cancel
        return;
      }
      setSelected(upNode); // tap a card → inspect it
      setWireMenu(null);
      return;
    }

    // Tap on empty canvas: a wire under the pointer opens its editor;
    // otherwise dismiss whatever is open (armed source, menu, panel).
    const hit = linkAtScreen(x, y);
    if (hit) {
      setWireMenu({ a: endId(hit.source), b: endId(hit.target), x, y });
      setSelected(null);
      return;
    }
    if (armed) setPendingSource(null);
    setWireMenu(null);
    setSelected(null);
  }

  // Live dashed preview from the wiring anchor (drag source or armed card).
  function onRenderFramePost(ctx: CanvasRenderingContext2D) {
    const anchor = dragSource.current ?? pendingRef.current;
    const fg = fgRef.current;
    if (!anchor || !pointer.current || !fg || anchor.x == null || anchor.y == null) return;
    const p = fg.screen2GraphCoords(pointer.current.x, pointer.current.y);
    ctx.save();
    ctx.strokeStyle = READ;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 5]);
    if (!reducedMotion) ctx.lineDashOffset = -((performance.now() / 30) % 22);
    ctx.globalAlpha = 0.95;
    ctx.beginPath();
    ctx.moveTo(anchor.x, anchor.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.restore();
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
      if (e.key === 'Escape') {
        if (pendingRef.current) setPendingSource(null);
        else if (wireMenu) setWireMenu(null);
        else if (showGuide) setShowGuide(false);
        else if (selected) setSelected(null);
        dragSource.current = null;
        pointer.current = null;
        setHoverTarget(null);
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
  }, [wireMenu, showGuide, selected, zoomIn, zoomOut, fitView]);

  const vaults = data?.nodes ?? [];
  const hasLinks = graphData.links.length > 0;

  // Plain-language label + direct (no-confirm) removal for the always-on list.
  function linkLabel(l: GLink): string {
    const from = nameOf(endId(l.source));
    const to = nameOf(endId(l.target));
    if (l.twoWay) return fmt(t('federation.map.conns.mutual'), { a: from, b: to });
    return (
      fmt(t('federation.map.conns.reads'), { from, to }) +
      (l.active ? '' : t('federation.map.conns.inert'))
    );
  }

  function removeLink(l: GLink) {
    const from = endId(l.source);
    const to = endId(l.target);
    removeConn.mutate({ from, to });
    if (l.twoWay) removeConn.mutate({ from: to, to: from });
  }

  // Rows for the wire editor — derived live so the menu tracks mutations and
  // closes itself once its last relationship is removed.
  const menuRels = useMemo(() => {
    if (!wireMenu) return [];
    return rels.filter(
      (r) =>
        (r.from === wireMenu.a && r.to === wireMenu.b) ||
        (r.from === wireMenu.b && r.to === wireMenu.a),
    );
  }, [wireMenu, rels]);
  useEffect(() => {
    if (wireMenu && menuRels.length === 0) setWireMenu(null);
  }, [wireMenu, menuRels]);
  const menuInert = menuRels.find((r) => !r.active);

  // Plain-language relationships for the selected card (the clarity anchor).
  const selectedRels = useMemo(() => {
    if (!selected) return [];
    const out: { text: string; onRemove: () => void }[] = [];
    for (const r of rels) {
      if (r.from !== selected.id && r.to !== selected.id) continue;
      const text =
        r.from === selected.id
          ? fmt(t('federation.map.detail.youRead'), { name: nameOf(r.to) }) +
            (r.active ? '' : t('federation.map.detail.notLive'))
          : fmt(t('federation.map.detail.readsYou'), { name: nameOf(r.from) });
      out.push({ text, onRemove: () => removeConn.mutate({ from: r.from, to: r.to }) });
    }
    return out;
  }, [selected, rels, removeConn, nameOf, t]);

  const hint = pendingSource
    ? fmt(t('federation.map.hint.armed'), { name: pendingSource.name })
    : hasLinks
      ? t('federation.map.hint.default')
      : t('federation.map.hint.first');

  const canvasCursor =
    dragging || pendingSource ? 'crosshair' : hoverTarget || hoverLink ? 'pointer' : 'grab';

  return (
    <div className={`lgraph${embedded ? ' lgraph--embedded' : ''}`}>
      <div className="lgraph-toolbar">
        <button type="button" className="lgraph-help" onClick={() => setShowGuide(true)}>
          {t('federation.map.help')}
        </button>
        <button
          type="button"
          className={`lgraph-help${showConns ? ' lgraph-help--on' : ''}`}
          onClick={() => setShowConns((v) => !v)}
        >
          {t('federation.map.connections')}
          {graphData.links.length ? ` (${graphData.links.length})` : ''}
        </button>
        <span className={`lgraph-hint${pendingSource ? ' lgraph-hint--armed' : ''}`}>{hint}</span>
      </div>

      {note && (
        <div className={`lgraph-note lgraph-note--${note.kind}`} role="status">
          <span>{note.text}</span>
          {note.action && (
            <button
              className="lgraph-note-action"
              onClick={() => {
                note.action?.run();
              }}
            >
              {note.action.label}
            </button>
          )}
          <button className="lgraph-note-x" onClick={() => setNote(null)} aria-label={t('common.close')}>
            ✕
          </button>
        </div>
      )}

      <div
        className="lgraph-canvas"
        ref={wrapRef}
        style={{ cursor: canvasCursor }}
        onPointerDownCapture={onPointerDownCapture}
        onMouseDownCapture={onMouseDownCapture}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {isLoading && <div className="lgraph-status">{t('federation.map.status.loading')}</div>}
        {isError && (
          <div className="lgraph-status lgraph-status--err">
            {error instanceof Error ? error.message : t('federation.map.status.error')}
          </div>
        )}
        {!isLoading && !isError && vaults.length < 2 && (
          <div className="lgraph-empty">
            <svg viewBox="0 0 220 56" className="lgraph-empty-svg" aria-hidden>
              <line x1="78" y1="28" x2="138" y2="28" stroke="#6741d9" strokeWidth="2" strokeDasharray="5 5" opacity="0.7" />
              <rect x="12" y="14" width="60" height="28" rx="8" fill="#b2f2bb" stroke="#2f9e44" strokeWidth="1.6" />
              <rect x="146" y="14" width="60" height="28" rx="8" fill="#ffec99" stroke="#f08c00" strokeWidth="1.6" />
            </svg>
            <strong>{t('federation.map.empty.title')}</strong>
            <p>{t('federation.map.empty.body')}</p>
          </div>
        )}

        {vaults.length >= 2 && (
          <div className="lgraph-zoom" role="group" aria-label="Zoom controls">
            <button
              type="button"
              className="lgraph-zoom-btn"
              onClick={zoomIn}
              aria-label={t('federation.map.zoom.in')}
              title={t('federation.map.zoom.in')}
            >
              +
            </button>
            <button
              type="button"
              className="lgraph-zoom-btn"
              onClick={zoomOut}
              aria-label={t('federation.map.zoom.out')}
              title={t('federation.map.zoom.out')}
            >
              −
            </button>
            <button
              type="button"
              className="lgraph-zoom-btn lgraph-zoom-fit"
              onClick={fitView}
              aria-label={t('federation.map.zoom.fit')}
              title={t('federation.map.zoom.fit')}
            >
              ⤢
            </button>
          </div>
        )}

        {vaults.length >= 2 && (
          <div className="lgraph-canvaslegend" aria-hidden>
            <span>
              <i className="lgwire lgwire--read" /> {t('federation.map.legend.live')}
            </span>
            <span>
              <i className="lgwire lgwire--inert" /> {t('federation.map.legend.inert')}
            </span>
            <span>
              <i className="lgchip lgchip--ok" /> {t('federation.map.legend.ok')}
              <i className="lgchip lgchip--stale" /> {t('federation.map.legend.stale')}
              <i className="lgchip lgchip--gone" /> {t('federation.map.legend.gone')}
            </span>
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
            // Pan/zoom are always live: a press ON a card is swallowed at
            // capture phase (drag-to-connect owns it), so the library only ever
            // sees empty-canvas presses — no gesture conflict, no mode toggle.
            enablePanInteraction={true}
            enableZoomInteraction={true}
            // Never drag nodes: a node-drag would swallow the tap that opens
            // the detail panel, and layout is the simulation's job.
            enableNodeDrag={false}
            // Keep redrawing after the physics settle so hover rings, the
            // armed-card pulse and the dashed wiring preview stay live.
            autoPauseRedraw={false}
            cooldownTicks={140}
            onEngineStop={onEngineStop}
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
              const tn = l.target as GNode;
              if (s.x == null || s.y == null || tn.x == null || tn.y == null) return;
              // Quadratic bow matching the library's linkCurvature, so the drawn
              // wire and its flowing particles ride the SAME arc. Control point =
              // midpoint offset perpendicular.
              const dist = Math.hypot(tn.x - s.x, tn.y - s.y) || 1;
              const mx0 = (s.x + tn.x) / 2;
              const my0 = (s.y + tn.y) / 2;
              const pang = Math.atan2(tn.y - s.y, tn.x - s.x) + Math.PI / 2;
              const cpx = mx0 + Math.cos(pang) * l.curv * dist;
              const cpy = my0 + Math.sin(pang) * l.curv * dist;
              // Clip endpoints to card edges along the tangent toward the control.
              const sE = rectExit(s.x, s.y, (s.__hw ?? 50) + 2, (s.__hh ?? 16) + 2, cpx, cpy);
              const tE = rectExit(tn.x, tn.y, (tn.__hw ?? 50) + 2, (tn.__hh ?? 16) + 2, cpx, cpy);
              const sx = sE.x;
              const sy = sE.y;
              const tx = tE.x;
              const ty = tE.y;
              const angT = Math.atan2(ty - cpy, tx - cpx); // tangent into target
              const angS = Math.atan2(sy - cpy, sx - cpx); // tangent into source
              const isHover = hoverLinkRef.current === linkPairKey(l);

              ctx.save();
              ctx.lineCap = 'round';
              if (l.active) {
                ctx.strokeStyle = isHover ? READ : READ_SOFT;
                ctx.lineWidth = isHover ? 3.2 : 2.2;
                ctx.setLineDash([]);
              } else {
                ctx.strokeStyle = isHover ? 'rgba(180,180,200,0.85)' : 'rgba(150,150,170,0.55)';
                ctx.lineWidth = isHover ? 2.4 : 1.6;
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
                const label = l.twoWay
                  ? t('federation.map.wire.mutual')
                  : t('federation.map.wire.reads');
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
              const isArmed = pendingRef.current?.id === n.id;
              const isHover = hoverRef.current === n.id;
              const isSelected = selectedRef.current?.id === n.id;
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
              if (isHover) {
                ctx.strokeStyle = READ;
                ctx.lineWidth = 2.4;
              } else {
                ctx.strokeStyle = style.stroke;
                ctx.lineWidth = 1.6;
              }
              ctx.stroke();

              // Inspected card: a quiet outer ring anchors the detail panel.
              if (isSelected) {
                ctx.strokeStyle = SELECT;
                ctx.lineWidth = 1.6;
                roundRect(ctx, x - 3.5, y - 3.5, w + 7, h + 7, 11.5);
                ctx.stroke();
              }

              // Armed click-to-connect source: marching-ants ring while waiting
              // for the target click.
              if (isArmed) {
                ctx.save();
                ctx.strokeStyle = READ;
                ctx.lineWidth = 1.8;
                ctx.setLineDash([6, 5]);
                if (!reducedMotion) ctx.lineDashOffset = -((performance.now() / 40) % 22);
                roundRect(ctx, x - 4, y - 4, w + 8, h + 8, 12);
                ctx.stroke();
                ctx.restore();
              }

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
          <div className="lgraph-conns" role="dialog" aria-label={t('federation.map.conns.title')}>
            <div className="lgraph-conns-head">
              <strong>{t('federation.map.conns.title')}</strong>
              <button
                className="lgraph-x"
                onClick={() => setShowConns(false)}
                aria-label={t('common.close')}
              >
                ✕
              </button>
            </div>
            {graphData.links.length === 0 ? (
              <div className="lgraph-conns-empty">{t('federation.map.conns.empty')}</div>
            ) : (
              graphData.links.map((l, i) => (
                <div className="lgraph-conn-row" key={i}>
                  <span
                    className={`lgchip-wire${l.active ? '' : ' lgchip-wire--inert'}`}
                    aria-hidden
                  />
                  <span className="lgraph-conn-label">{linkLabel(l)}</span>
                  <button
                    className="lgraph-conn-del"
                    onClick={() => removeLink(l)}
                    aria-label={t('federation.map.wiremenu.remove')}
                    title={t('federation.map.wiremenu.remove')}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {wireMenu && menuRels.length > 0 && (
          <div
            className="lgraph-wiremenu"
            role="dialog"
            aria-label={t('federation.map.wiremenu.title')}
            style={{
              left: clamp(wireMenu.x, 8, Math.max(8, dims.w - 268)),
              top: clamp(wireMenu.y + 10, 8, Math.max(8, dims.h - 140)),
            }}
          >
            <div className="lgraph-wiremenu-head">
              <strong>{t('federation.map.wiremenu.title')}</strong>
              <button
                className="lgraph-x"
                onClick={() => setWireMenu(null)}
                aria-label={t('common.close')}
              >
                ✕
              </button>
            </div>
            {menuRels.map((r) => (
              <div className="lgraph-wiremenu-row" key={`${r.from}→${r.to}`}>
                <div className="lgraph-wiremenu-info">
                  <span>
                    {fmt(t('federation.map.wiremenu.row'), {
                      from: nameOf(r.from),
                      to: nameOf(r.to),
                    })}
                  </span>
                  {!r.active && (
                    <span className="lgraph-wiremenu-warn">
                      {fmt(t('federation.map.wiremenu.notLive'), { name: nameOf(r.to) })}
                    </span>
                  )}
                </div>
                <button
                  className="lgraph-wiremenu-del"
                  onClick={() => removeConn.mutate({ from: r.from, to: r.to })}
                >
                  {t('federation.map.wiremenu.remove')}
                </button>
              </div>
            ))}
            {menuInert && (
              <button
                className="lgraph-wiremenu-fix"
                onClick={() => makeReadable(menuInert.to, nameOf(menuInert.to))}
                disabled={toggleShareable.isPending}
              >
                {fmt(t('federation.map.wiremenu.makeReadable'), { name: nameOf(menuInert.to) })}
              </button>
            )}
          </div>
        )}
      </div>

      {selected && (
        <div className="lgraph-detail">
          <div className="lgraph-detail-head">
            <span
              className="lgchip"
              style={{
                background: cardStyle(selected).fill,
                borderColor: cardStyle(selected).stroke,
              }}
            />
            <strong>{selected.name}</strong>
            <button
              className="lgraph-x"
              onClick={() => setSelected(null)}
              aria-label={t('common.close')}
            >
              ✕
            </button>
          </div>
          <div className="lgraph-detail-path">{selected.path}</div>
          <div className="lgraph-detail-row">
            <span>
              {!selected.exists
                ? t('federation.map.detail.gone')
                : selected.needsUpdate
                  ? fmt(t('federation.map.detail.behind'), {
                      from: selected.setupVersion,
                      to: selected.latestVersion,
                    })
                  : fmt(t('federation.map.detail.current'), { v: selected.setupVersion })}
            </span>
            {selected.exists && selected.needsUpdate && (
              <button
                className="lgraph-btn"
                disabled={updateProject.isPending}
                onClick={() => updateProject.mutate(selected.name)}
              >
                {updateProject.isPending
                  ? t('federation.map.detail.updating')
                  : t('federation.map.detail.update')}
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
            <span>{t('federation.map.detail.readable')}</span>
          </label>

          {selected.exists && vaults.length >= 2 && (
            <button
              className="lgraph-btn lgraph-connectbtn"
              onClick={() => {
                // Arm click-to-connect: the panel closes so the board (and the
                // pulsing armed card + hint bar) takes over the guidance.
                setPendingSource(selected);
                setSelected(null);
                setWireMenu(null);
              }}
            >
              {t('federation.map.detail.connect')}
            </button>
          )}

          <div className="lgraph-rels">
            <div className="lgraph-rels-title">{t('federation.map.detail.connections')}</div>
            {selectedRels.length === 0 && (
              <div className="lgraph-rels-empty">{t('federation.map.detail.none')}</div>
            )}
            {selectedRels.map((r, i) => (
              <div className="lgraph-rel" key={i}>
                <span>{r.text}</span>
                <button
                  className="lgraph-rel-x"
                  onClick={r.onRemove}
                  aria-label={t('federation.map.wiremenu.remove')}
                >
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

/** Illustrated explainer with a live mini diagram + the three interactions. */
function GraphGuide({ hasLinks, onClose }: { hasLinks: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <div className="lgraph-guide" role="dialog" aria-label={t('federation.map.guide.title')}>
      <button className="lgraph-guide-x" onClick={onClose} aria-label={t('common.close')}>
        ✕
      </button>
      <h3 className="lgraph-guide-title">{t('federation.map.guide.title')}</h3>

      <div className="lgraph-guide-demo" aria-hidden>
        <svg viewBox="0 0 260 60" className="lgraph-guide-svg">
          <line
            className="lgraph-guide-flow"
            x1="92"
            y1="30"
            x2="168"
            y2="30"
            stroke="#6741d9"
            strokeWidth="2.4"
          />
          <polygon points="168,26 176,30 168,34" fill="#6741d9" />
          <rect x="14" y="16" width="70" height="28" rx="8" fill="#b2f2bb" stroke="#2f9e44" strokeWidth="1.6" />
          <text x="49" y="31" textAnchor="middle" className="lgraph-guide-cardlabel">
            App
          </text>
          <rect x="176" y="16" width="70" height="28" rx="8" fill="#b2f2bb" stroke="#2f9e44" strokeWidth="1.6" />
          <circle cx="240" cy="20" r="3.2" fill="#6741d9" stroke="#0b0b12" strokeWidth="1" />
          <text x="211" y="31" textAnchor="middle" className="lgraph-guide-cardlabel">
            Libs
          </text>
          <text x="130" y="23" textAnchor="middle" className="lgraph-guide-wirelabel" fill="#b9a6ff">
            {t('federation.map.wire.reads')}
          </text>
        </svg>
        <p className="lgraph-guide-caption">{t('federation.map.guide.def')}</p>
      </div>

      <ol className="lgraph-guide-steps">
        <li>
          <span className="lgraph-guide-step">1</span>
          <span>{t('federation.map.guide.step1')}</span>
        </li>
        <li>
          <span className="lgraph-guide-step">2</span>
          <span>{t('federation.map.guide.step2')}</span>
        </li>
        <li>
          <span className="lgraph-guide-step">3</span>
          <span>{t('federation.map.guide.step3')}</span>
        </li>
      </ol>

      <p className="lgraph-guide-foot">{t('federation.map.guide.keys')}</p>

      <button className="lgraph-guide-cta" onClick={onClose}>
        {hasLinks ? t('federation.map.guide.gotit') : t('federation.map.guide.start')}
      </button>
    </div>
  );
}
