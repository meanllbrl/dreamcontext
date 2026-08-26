import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  useFederationGraph,
  useCreateConnection,
  useRemoveLauncherConnection,
  useUpdateProject,
  useUnregisterVault,
  useTouchVault,
  type VaultStatus,
} from '../../hooks/useLauncher';
import { useTeamUpdates } from '../../hooks/useBrainStatus';
import { confirmAction, openVaultWindow } from '../../lib/desktop';
import { BrandMark } from '../../components/brand/BrandMark';
import { layoutSpace, bodyPoint, type SpaceBody } from './spaceLayout';
import './SpaceLauncher.css';

/** Degrees per second the sky drifts on its own. Slow enough to never chase a target. */
const DRIFT_DEG_PER_SEC = 0.6;
/** Degrees of spin per pixel of horizontal drag. */
const DRAG_DEG_PER_PX = 0.22;
const ZOOM_MIN = 0.42;
const ZOOM_MAX = 1.7;
/** Pointer travel (px) before a chip press becomes a wire drag instead of a click. */
const WIRE_SLOP = 7;

type Status = 'ok' | 'stale' | 'gone';

function statusOf(v: VaultStatus): Status {
  if (!v.exists) return 'gone';
  if (v.needsUpdate) return 'stale';
  return 'ok';
}

function relativeTime(iso: string | null): string {
  if (!iso) return 'never opened';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return 'never opened';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.round(days / 30)}mo ago`;
}

/** Deterministic PRNG so the starfield is identical on every render and relaunch. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Star {
  x: number;
  y: number;
  r: number;
  o: number;
}

function makeStars(size: number, count: number): Star[] {
  const rnd = mulberry32(0x5eed);
  const stars: Star[] = [];
  for (let i = 0; i < count; i++) {
    // Polar so density stays even instead of clumping in the corners.
    const a = rnd() * Math.PI * 2;
    const r = Math.sqrt(rnd()) * (size / 2);
    stars.push({
      x: Math.cos(a) * r,
      y: Math.sin(a) * r,
      r: 0.5 + rnd() * 1.3,
      o: 0.12 + rnd() * 0.5,
    });
  }
  return stars;
}

/** A wire as drawn: one path per stored direction, bowed apart from its mirror. */
interface Wire {
  from: string;
  to: string;
  d: string;
}

/** What the cockpit is currently describing. */
type Focus = { kind: 'vault'; name: string } | { kind: 'wire'; from: string; to: string } | null;

export interface SpaceLauncherProps {
  /** Live search text from the launcher bar — dims everything that doesn't match. */
  query: string;
  /** Open the add-project wizard (the centre core and the empty state call this). */
  onAddProject: () => void;
  /**
   * Open the hidden Meeting Room — the core's click when projects EXIST. An
   * empty sky keeps the wizard: there is no one to convene, and first-run users
   * need the front door, not an easter egg.
   */
  onOpenMeetingRoom: () => void;
  /** Surface an action failure in the launcher's error banner. */
  onError: (message: string | null) => void;
}

/**
 * The Space — the launcher's single surface. Every registered project is a body
 * in orbit around the dreamcontext core:
 *
 *   • RADIUS is recency — what you opened last is nearest the centre.
 *   • ANGLE is kinship — federated projects share an arc and sit inside a common
 *     gas cloud, so a related group reads as one thing.
 *   • WIRES are live "reads" edges. Drag one project onto another to create one;
 *     click a wire to edit it. This replaces the old separate Network view — there
 *     is one sky, not a card list plus a graph.
 *
 * Interaction survives scale: chips are real buttons (tab/arrow reachable), the
 * search dims non-matches instead of re-laying out the sky, rings absorb new
 * projects without crowding, and the whole thing spins, zooms, and pans.
 */
export function SpaceLauncher({ query, onAddProject, onOpenMeetingRoom, onError }: SpaceLauncherProps) {
  const { data, isLoading, isError, error } = useFederationGraph();
  const { data: teamVaults } = useTeamUpdates();
  const createConn = useCreateConnection();
  const removeConn = useRemoveLauncherConnection();
  const updateProject = useUpdateProject();
  const unregister = useUnregisterVault();
  const touch = useTouchVault();

  const rootRef = useRef<HTMLDivElement>(null);
  const rotorRef = useRef<HTMLDivElement>(null);
  const spinRef = useRef(0);
  /** Drift pauses while the user is reading or manipulating something. */
  const pausedRef = useRef(false);

  const [focus, setFocus] = useState<Focus>(null);
  /**
   * Screen-space nudge that keeps an opened card fully on canvas. A project on
   * an outer ring can sit close enough to the edge that its card hangs off it,
   * and a card with its buttons cut off is worse than one that has drifted a
   * little from the pill it grew out of. Bounded by the overflow itself, so the
   * card never travels further than it must.
   */
  const [cardNudge, setCardNudge] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [hover, setHover] = useState<string | null>(null);
  /** `from|to` of the wire under the pointer — thickens it before the click. */
  const [hoverWire, setHoverWire] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [wireDrag, setWireDrag] = useState<{ from: string; x: number; y: number } | null>(null);

  const nodes = useMemo(() => data?.nodes ?? [], [data]);
  const edges = useMemo(() => data?.edges ?? [], [data]);
  const layout = useMemo(() => layoutSpace(nodes, edges), [nodes, edges]);

  /**
   * The sky reacts to change. When a wire appears or disappears — or a project
   * joins the registry — the affected bodies ripple for a beat, so a mutation
   * that happened somewhere else on screen (or in another window) is impossible
   * to miss. Diffed against the PREVIOUS payload, so a plain refetch that
   * changed nothing animates nothing.
   */
  const [pulse, setPulse] = useState<Map<string, 'wire' | 'unwire' | 'new'>>(new Map());
  const [freshWires, setFreshWires] = useState<Set<string>>(new Set());
  const prevGraph = useRef<{ edges: Set<string>; nodes: Set<string> } | null>(null);
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const edgeKeys = new Set(edges.map((e) => `${e.source}|${e.target}`));
    const nodeKeys = new Set(nodes.map((n) => n.name));
    const prev = prevGraph.current;
    prevGraph.current = { edges: edgeKeys, nodes: nodeKeys };
    // First payload is the world as it already was, not a change to announce.
    if (!prev) return;

    const next = new Map<string, 'wire' | 'unwire' | 'new'>();
    const fresh = new Set<string>();
    for (const key of edgeKeys) {
      if (prev.edges.has(key)) continue;
      const [a, b] = key.split('|');
      next.set(a, 'wire');
      next.set(b, 'wire');
      fresh.add(key);
    }
    for (const key of prev.edges) {
      if (edgeKeys.has(key)) continue;
      const [a, b] = key.split('|');
      // Only ripple ends that still exist — a wire lost because its project was
      // removed should not make a ghost flash.
      if (nodeKeys.has(a)) next.set(a, 'unwire');
      if (nodeKeys.has(b)) next.set(b, 'unwire');
    }
    for (const name of nodeKeys) {
      if (!prev.nodes.has(name)) next.set(name, 'new');
    }
    if (next.size === 0) return;

    setPulse(next);
    setFreshWires(fresh);
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
    pulseTimer.current = setTimeout(() => {
      setPulse(new Map());
      setFreshWires(new Set());
    }, 1100);
  }, [edges, nodes]);

  useEffect(() => () => {
    if (pulseTimer.current) clearTimeout(pulseTimer.current);
  }, []);

  const size = Math.max(1500, Math.round((layout.extent + 260) * 2));
  const half = size / 2;
  const stars = useMemo(() => makeStars(size, 260), [size]);

  const bodyByName = useMemo(() => {
    const m = new Map<string, SpaceBody>();
    for (const b of layout.bodies) m.set(b.vault.name, b);
    return m;
  }, [layout]);

  const brainByVault = useMemo(
    () => new Map((teamVaults ?? []).map((v) => [v.name, v])),
    [teamVaults],
  );

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (v: VaultStatus) =>
      !q || v.name.toLowerCase().includes(q) || v.path.toLowerCase().includes(q),
    [q],
  );
  const hitCount = useMemo(
    () => (q ? layout.bodies.filter((b) => matches(b.vault)).length : layout.bodies.length),
    [layout, matches, q],
  );

  // ─── Wires ────────────────────────────────────────────────────────────────
  const wires = useMemo<Wire[]>(() => {
    const out: Wire[] = [];
    for (const e of edges) {
      const a = bodyByName.get(e.source);
      const b = bodyByName.get(e.target);
      if (!a || !b) continue;
      const pa = bodyPoint(a);
      const pb = bodyPoint(b);
      // Bow each direction to its own side so A→B and B→A never overlap. The
      // sign comes from name order, so the pair is stable across refetches.
      const side = e.source < e.target ? 1 : -1;
      const mx = (pa.x + pb.x) / 2;
      const my = (pa.y + pb.y) / 2;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const len = Math.hypot(dx, dy) || 1;
      const cx = mx + (-dy / len) * len * 0.1 * side;
      const cy = my + (dx / len) * len * 0.1 * side;
      out.push({
        from: e.source,
        to: e.target,
        d: `M ${pa.x.toFixed(1)} ${pa.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${pb.x.toFixed(1)} ${pb.y.toFixed(1)}`,
      });
    }
    return out;
  }, [edges, bodyByName]);

  /** Names federated with `name` (any distance) — used to light up a cloud. */
  const kinOf = useCallback(
    (name: string | null): Set<string> => {
      if (!name) return new Set();
      const body = bodyByName.get(name);
      if (!body || body.cloud < 0) return new Set([name]);
      return new Set(layout.clouds[body.cloud]?.members ?? [name]);
    },
    [bodyByName, layout],
  );
  const liveKin = useMemo(
    () => kinOf(focus?.kind === 'vault' ? focus.name : hover),
    [kinOf, focus, hover],
  );

  // ─── Drift ────────────────────────────────────────────────────────────────
  pausedRef.current = !!focus || !!hover || !!wireDrag;

  useEffect(() => {
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduced) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!pausedRef.current) {
        spinRef.current = (spinRef.current + DRIFT_DEG_PER_SEC * dt) % 360;
        rotorRef.current?.style.setProperty('--spin', `${spinRef.current.toFixed(3)}deg`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (focus?.kind !== 'vault') {
      setCardNudge({ x: 0, y: 0 });
      return;
    }
    // Measure with no nudge applied, then apply exactly the correction needed.
    setCardNudge({ x: 0, y: 0 });
    const id = requestAnimationFrame(() => {
      const root = rootRef.current;
      const card = root?.querySelector('.space-card');
      if (!root || !card) return;
      const r = root.getBoundingClientRect();
      const c = card.getBoundingClientRect();
      const m = 12;
      let x = 0;
      let y = 0;
      if (c.left < r.left + m) x = r.left + m - c.left;
      else if (c.right > r.right - m) x = r.right - m - c.right;
      if (c.top < r.top + m) y = r.top + m - c.top;
      else if (c.bottom > r.bottom - m) y = r.bottom - m - c.bottom;
      if (x !== 0 || y !== 0) setCardNudge({ x, y });
    });
    return () => cancelAnimationFrame(id);
  }, [focus, zoom]);

  // ─── Actions ──────────────────────────────────────────────────────────────
  const open = useCallback(
    async (name: string) => {
      onError(null);
      // Stamp recency FIRST so the body has moved inward by the time the user
      // comes back to the launcher, then open. A failed stamp must not block.
      touch.mutate(name);
      try {
        await openVaultWindow(name);
      } catch (err) {
        onError(err instanceof Error ? err.message : String(err));
      }
    },
    [onError, touch],
  );

  const connect = useCallback(
    (from: string, to: string) => {
      if (from === to) return;
      onError(null);
      createConn.mutate(
        { from, to },
        { onError: (err) => onError(err instanceof Error ? err.message : String(err)) },
      );
    },
    [createConn, onError],
  );

  function handleUpdate(name: string) {
    onError(null);
    updateProject.mutate(name, {
      onError: (err) => onError(err instanceof Error ? err.message : String(err)),
    });
  }

  async function handleRemove(v: VaultStatus) {
    const ok = await confirmAction({
      title: `Remove “${v.name}” from the launcher?`,
      body: v.exists ? 'The folder stays on disk.' : 'Its folder is gone from disk.',
      confirmLabel: 'Remove',
      destructive: true,
    });
    if (!ok) return;
    onError(null);
    setFocus(null);
    unregister.mutate(v.name, {
      onError: (err) => onError(err instanceof Error ? err.message : String(err)),
    });
  }

  /**
   * What the expanded card SAYS about a project: one line per fact, in a fixed
   * order so the same thing is always in the same place. Facts only — anything
   * you can act on is a button in the card's action row, because a statement and
   * a control that look alike is the confusion this card exists to end.
   */
  function factsFor(v: VaultStatus): { key: string; glyph: string; text: string }[] {
    const out: { key: string; glyph: string; text: string }[] = [];
    const team = brainByVault.get(v.name);

    if (!v.exists) {
      out.push({ key: 'gone', glyph: '⚠', text: 'Folder is missing from disk' });
    } else if (v.needsUpdate) {
      out.push({
        key: 'version',
        glyph: '↻',
        text: `Skills on v${v.setupVersion} — the CLI installs v${v.latestVersion}`,
      });
    } else {
      out.push({ key: 'version', glyph: '✓', text: `Up to date · v${v.setupVersion}` });
    }

    if (v.exists) {
      const syncing = team?.enabled && team.mode === 'full-repo';
      out.push({
        key: 'sync',
        glyph: syncing ? '☁' : '○',
        text: !syncing
          ? 'No team sync set up'
          : team.pendingAgentMerge
            ? 'A team merge is waiting to be resolved'
            : team.updates > 0
              ? `${team.updates} team update${team.updates === 1 ? '' : 's'} to pull`
              : 'Team sync · up to date',
      });
    }

    out.push({
      key: 'seen',
      glyph: '◷',
      text: v.lastOpenedAt
        ? `Opened ${relativeTime(v.lastOpenedAt)} — that sets its distance from the centre`
        : 'Never opened from the launcher',
    });
    return out;
  }

  // ─── Sky gestures: drag to spin, wheel to zoom ────────────────────────────
  function onBackgroundPointerDown(e: React.PointerEvent) {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startSpin = spinRef.current;
    let moved = false;
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      spinRef.current = startSpin + dx * DRAG_DEG_PER_PX;
      rotorRef.current?.style.setProperty('--spin', `${spinRef.current.toFixed(3)}deg`);
    };
    const up = () => {
      el.releasePointerCapture?.(e.pointerId);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      // A press that never moved is a click on empty space: dismiss.
      if (!moved) {
        setFocus(null);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onWheel(e: React.WheelEvent) {
    const next = zoom * (e.deltaY > 0 ? 0.92 : 1.08);
    setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next)));
  }

  // ─── Chip gestures: click to focus, drag onto a peer to wire ──────────────
  function onChipPointerDown(e: React.PointerEvent, name: string) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    const move = (ev: PointerEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) < WIRE_SLOP) return;
      dragging = true;
      setWireDrag({ from: name, x: ev.clientX, y: ev.clientY });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (!dragging) return;
      setWireDrag(null);
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const target = el instanceof Element ? el.closest('[data-vault]') : null;
      const to = target?.getAttribute('data-vault');
      if (to && to !== name) connect(name, to);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function onChipClick(name: string) {
    setFocus((f) => (f?.kind === 'vault' && f.name === name ? null : { kind: 'vault', name }));
  }

  // ─── Keyboard: arrows walk the sky, Enter opens ───────────────────────────
  const ordered = useMemo(
    () =>
      [...layout.bodies].sort(
        (a, b) => a.ring - b.ring || a.angle - b.angle || a.vault.name.localeCompare(b.vault.name),
      ),
    [layout],
  );

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') {
        setFocus(null);
        return;
      }
      if (ordered.length === 0) return;
      const current = focus?.kind === 'vault' ? focus.name : null;
      const idx = current ? ordered.findIndex((b) => b.vault.name === current) : -1;

      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const ring = idx >= 0 ? ordered[idx].ring : 0;
        const inRing = ordered.filter((b) => b.ring === ring);
        const at = Math.max(0, inRing.findIndex((b) => b.vault.name === current));
        const step = e.key === 'ArrowRight' ? 1 : -1;
        const next = inRing[(at + step + inRing.length) % inRing.length];
        setFocus({ kind: 'vault', name: next.vault.name });
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const maxRing = ordered[ordered.length - 1].ring;
        const ring = idx >= 0 ? ordered[idx].ring : -1;
        const want = Math.min(maxRing, Math.max(0, ring + (e.key === 'ArrowDown' ? 1 : -1)));
        const angle = idx >= 0 ? ordered[idx].angle : 0;
        const candidates = ordered.filter((b) => b.ring === want);
        if (candidates.length === 0) return;
        // Nearest in angle, so moving out feels radial rather than random.
        const next = candidates.reduce((best, b) =>
          Math.abs(b.angle - angle) < Math.abs(best.angle - angle) ? b : best,
        );
        setFocus({ kind: 'vault', name: next.vault.name });
        return;
      }
      if (e.key === 'Enter' && current) {
        e.preventDefault();
        void open(current);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ordered, focus, open]);

  // ─── Render ───────────────────────────────────────────────────────────────
  if (isLoading) return <div className="space-status">Charting the sky…</div>;
  if (isError) {
    return (
      <div className="space-status space-status--error">
        {error instanceof Error ? error.message : 'Failed to load projects.'}
      </div>
    );
  }

  const focusWire =
    focus?.kind === 'wire'
      ? (wires.find((w) => w.from === focus.from && w.to === focus.to) ?? null)
      : null;

  return (
    <div
      // `surface-night`: the sky has no light theme, so the canvas pins the dark
      // palette for everything inside it (see tokens.css). In light mode the app's
      // own tokens are dark-on-light, and every one of them landed on a black sky —
      // chip labels, the HUD hint, the open card and the cockpit all went dark-on-dark.
      className={`space surface-night${focus?.kind === 'vault' ? ' space--focus' : ''}`}
      ref={rootRef}
      data-no-drag
      onWheel={onWheel}
      onPointerDown={onBackgroundPointerDown}
    >
      <div className="space-stage" style={{ ['--zoom' as string]: String(zoom) }}>
        <div className="space-rotor" ref={rotorRef} style={{ ['--spin' as string]: '0deg' }}>
          <svg
            className="space-sky"
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            aria-hidden="true"
          >
            <defs>
              <filter id="space-nebula" x="-40%" y="-40%" width="180%" height="180%">
                <feGaussianBlur stdDeviation="34" />
              </filter>
            </defs>

            {/* Stars drift on their own, far slower than the sky — parallax depth. */}
            <g
              className="space-stars"
              style={{ transformBox: 'view-box', transformOrigin: `${half}px ${half}px` }}
            >
              <g transform={`translate(${half},${half})`}>
                {stars.map((s, i) => (
                  <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="#cdd3ff" opacity={s.o} />
                ))}
              </g>
            </g>

            <g
              className="space-rotating"
              style={{ transformBox: 'view-box', transformOrigin: `${half}px ${half}px` }}
            >
              <g transform={`translate(${half},${half})`}>
                {/* Ring guides — faint, so radius reads as a scale, not decoration. */}
                {[...new Set(layout.bodies.map((b) => b.radius))].map((r) => (
                  <circle key={r} className="space-ringline" cx={0} cy={0} r={r} />
                ))}

                {/* Clouds: one blurred blob per member, unioned by the blur itself. */}
                <g filter="url(#space-nebula)">
                  {layout.clouds.map((cloud) => {
                    const live = cloud.members.some((m) => liveKin.has(m));
                    return (
                      <g
                        key={cloud.index}
                        className={`space-cloud${live ? ' is-live' : ''}`}
                        style={{ ['--hue' as string]: String(cloud.hue) }}
                      >
                        {cloud.members.map((m) => {
                          const b = bodyByName.get(m);
                          if (!b) return null;
                          const p = bodyPoint(b);
                          return <circle key={m} cx={p.x} cy={p.y} r={116} />;
                        })}
                      </g>
                    );
                  })}
                </g>

                {/* Wires */}
                {wires.map((w) => {
                  const lit = liveKin.has(w.from) || liveKin.has(w.to);
                  const isFocused =
                    focus?.kind === 'wire' && focus.from === w.from && focus.to === w.to;
                  return (
                    <g
                      key={`${w.from}|${w.to}`}
                      className={`space-wire-group${
                        hoverWire === `${w.from}|${w.to}` ? ' is-hovered' : ''
                      }`}
                    >
                      {/* Fat invisible stroke: a 2px line is unclickable in
                          practice, and the visible wire thickens on hover so the
                          target is obvious BEFORE the click. */}
                      <path
                        className="space-wire-hit"
                        d={w.d}
                        onPointerDown={(e) => e.stopPropagation()}
                        onPointerEnter={() => setHoverWire(`${w.from}|${w.to}`)}
                        onPointerLeave={() =>
                          setHoverWire((h) => (h === `${w.from}|${w.to}` ? null : h))
                        }
                        onClick={() => setFocus({ kind: 'wire', from: w.from, to: w.to })}
                      >
                        <title>{`${w.from} reads ${w.to} — click to edit`}</title>
                      </path>
                      <path
                        className={`space-wire is-active${lit ? ' is-lit' : ''}${
                          isFocused ? ' is-focused' : ''
                        }${freshWires.has(`${w.from}|${w.to}`) ? ' is-fresh' : ''}`}
                        d={w.d}
                      />
                    </g>
                  );
                })}
              </g>
            </g>
          </svg>

          {/* Bodies live in the same rotating frame; each chip counter-rotates so
              its label stays upright no matter where the sky is pointing. */}
          {layout.bodies.map((b) => {
            const v = b.vault;
            const selected = focus?.kind === 'vault' && focus.name === v.name;
            const dim = q ? !matches(v) : false;
            const kin = liveKin.has(v.name) && !selected;
            return (
              <div
                key={v.name}
                className={`space-body ring-${Math.min(b.ring, 3)}${selected ? ' is-selected' : ''}${
                  dim ? ' is-dim' : ''
                }${kin ? ' is-kin' : ''}${
                  pulse.has(v.name) ? ` pulse-${pulse.get(v.name)}` : ''
                }`}
                style={{
                  ['--a' as string]: `${b.angle.toFixed(2)}deg`,
                  ['--r' as string]: `${b.radius}px`,
                }}
              >
                {/* Unselected: a pill. Selected: the SAME anchor grows into a
                    card in place. One object that opens, not a pill that spawns
                    satellites elsewhere — the thing you clicked is the thing that
                    answers you. */}
                {!selected ? (
                  <button
                    type="button"
                    className={`space-chip status-${statusOf(v)}`}
                    data-vault={v.name}
                    title={`${v.path}\nLast opened ${relativeTime(v.lastOpenedAt)}`}
                    onPointerDown={(e) => onChipPointerDown(e, v.name)}
                    onClick={() => onChipClick(v.name)}
                    onDoubleClick={() => void open(v.name)}
                    onMouseEnter={() => setHover(v.name)}
                    onMouseLeave={() => setHover((h) => (h === v.name ? null : h))}
                    onFocus={() => setHover(v.name)}
                    onBlur={() => setHover((h) => (h === v.name ? null : h))}
                  >
                    <span className="space-chip-dot" aria-hidden="true" />
                    <span className="space-chip-name">{v.name}</span>
                    {v.needsUpdate && <span className="space-chip-flag">update</span>}
                  </button>
                ) : (
                  <div
                    className={`space-card status-${statusOf(v)}`}
                    data-vault={v.name}
                    style={{
                      ['--card-dx' as string]: `${cardNudge.x}px`,
                      ['--card-dy' as string]: `${cardNudge.y}px`,
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <div className="space-card-head">
                      <span className="space-chip-dot" aria-hidden="true" />
                      <span className="space-card-name">{v.name}</span>
                      <button
                        type="button"
                        className="space-card-close"
                        aria-label="Close"
                        onClick={() => setFocus(null)}
                      >
                        ✕
                      </button>
                    </div>
                    <div className="space-card-path" title={v.path}>
                      {v.path}
                    </div>
                    <ul className="space-card-facts">
                      {factsFor(v).map((f) => (
                        <li key={f.key}>
                          <span className="space-card-glyph" aria-hidden="true">
                            {f.glyph}
                          </span>
                          {f.text}
                        </li>
                      ))}
                    </ul>
                    <div className="space-card-actions">
                      {v.exists && (
                        <button
                          type="button"
                          className="space-btn space-btn--primary"
                          onClick={() => void open(v.name)}
                        >
                          Open project ↗
                        </button>
                      )}
                      {v.exists && v.needsUpdate && (
                        <button
                          type="button"
                          className="space-btn space-btn--update"
                          disabled={updateProject.isPending}
                          onClick={() => handleUpdate(v.name)}
                        >
                          {updateProject.isPending && updateProject.variables === v.name
                            ? 'Updating…'
                            : `Update to v${v.latestVersion}`}
                        </button>
                      )}
                      <button
                        type="button"
                        className="space-btn space-btn--danger"
                        disabled={unregister.isPending}
                        onClick={() => handleRemove(v)}
                      >
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* The core never rotates — it is the fixed thing everything orbits.
            With projects in the sky its click convenes them (the hidden Meeting
            Room); an empty sky keeps the add-project door. */}
        <button
          type="button"
          className="space-core"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={layout.bodies.length > 0 ? onOpenMeetingRoom : onAddProject}
          title={layout.bodies.length > 0 ? undefined : 'Add a project'}
        >
          <span className="space-core-halo" aria-hidden="true" />
          <BrandMark size={92} glow />
          <span className="space-core-label">
            {layout.bodies.length === 0
              ? 'Add your first project'
              : `${layout.bodies.length} project${layout.bodies.length === 1 ? '' : 's'}`}
          </span>
        </button>
      </div>

      {/* Drag-to-wire rubber band, drawn in screen space so it tracks the cursor. */}
      {wireDrag && <WireRubberBand drag={wireDrag} rootRef={rootRef} />}

      <div className="space-hud">
        <div className="space-hud-hint">
          {q
            ? `${hitCount} of ${layout.bodies.length} match`
            : 'Drag to spin · scroll to zoom · drag one project onto another to wire it'}
        </div>
        <div className="space-hud-zoom">
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z * 0.88))} aria-label="Zoom out">
            −
          </button>
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setZoom(1)} aria-label="Reset zoom">
            ⌾
          </button>
          <button type="button" onPointerDown={(e) => e.stopPropagation()} onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * 1.14))} aria-label="Zoom in">
            +
          </button>
        </div>
      </div>

      {layout.bodies.length === 0 && (
        <div className="space-empty">
          Nothing in orbit yet. Add a project and it becomes the first body in your sky.
        </div>
      )}

      {focusWire && (
        <div className="space-cockpit space-cockpit--bottom" onPointerDown={(e) => e.stopPropagation()}>
          <div className="space-cockpit-head">
            <strong>
              {focusWire.from} <span className="space-cockpit-arrow">reads</span> {focusWire.to}
            </strong>
            <button
              type="button"
              className="space-cockpit-close"
              onClick={() => setFocus(null)}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div className="space-cockpit-path">
            {`“${focusWire.from}” reaches into “${focusWire.to}” during recall. Live reference — nothing is copied.`}
          </div>
          <div className="space-cockpit-actions">
            <button
              type="button"
              className="space-btn space-btn--danger"
              disabled={removeConn.isPending}
              onClick={() => {
                removeConn.mutate(
                  { from: focusWire.from, to: focusWire.to },
                  { onError: (err) => onError(err instanceof Error ? err.message : String(err)) },
                );
                setFocus(null);
              }}
            >
              Remove this read
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The rubber band shown while dragging one project onto another. Screen-space on
 * purpose: it must track the cursor exactly, and the sky's rotation/zoom would
 * otherwise skew it.
 */
function WireRubberBand({
  drag,
  rootRef,
}: {
  drag: { from: string; x: number; y: number };
  rootRef: React.RefObject<HTMLDivElement | null>;
}) {
  const rect = rootRef.current?.getBoundingClientRect();
  const source = document
    .querySelector(`[data-vault="${CSS.escape(drag.from)}"]`)
    ?.getBoundingClientRect();
  if (!rect || !source) return null;
  const x1 = source.left + source.width / 2 - rect.left;
  const y1 = source.top + source.height / 2 - rect.top;
  return (
    <svg className="space-rubber" width={rect.width} height={rect.height} aria-hidden="true">
      <line x1={x1} y1={y1} x2={drag.x - rect.left} y2={drag.y - rect.top} />
      <circle cx={drag.x - rect.left} cy={drag.y - rect.top} r={5} />
    </svg>
  );
}
