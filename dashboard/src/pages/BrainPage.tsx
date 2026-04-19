import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
// d3-force-3d ships the same API as d3-force (forceCollide, forceX, forceY, …)
// and is the simulation engine react-force-graph already uses under the hood.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — d3-force-3d has no bundled types
import { forceCollide, forceX, forceY } from 'd3-force-3d';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGraph,
  type Graph,
  type GraphGroup,
  type GraphLink,
  type GraphNode,
} from '../hooks/useGraph';
import { useGraphSettings, mapForces, type GraphColorGroup } from '../hooks/useGraphSettings';
import { parseQuery, type ParsedQuery } from '../lib/obsidian-search';
import { BrainSettings } from '../components/brain/BrainSettings';
import { NodeDrawer, type BrainNavigatePage } from '../components/brain/NodeDrawer';
import { useTheme } from '../context/ThemeContext';
import './BrainPage.css';

export type { BrainNavigatePage };

// ─── Default color mapping (matches _dream_context/.obsidian/graph.json) ────
// Dark-mode palette uses bright, low-saturation colors that pop on #151518.
// Light-mode palette uses deeper, more saturated colors that hold contrast on white.
const DEFAULT_GROUP_COLORS_DARK: Record<GraphGroup, string> = {
  soul: '#4fb3e6',
  user: '#4fb3e6',
  memory: '#4fb3e6',
  core: '#4fb3e6',
  feature: '#10b981',
  task: '#f59e0b',
  knowledge: '#a78bfa',
  release: '#e11d74',
  inbox: '#9ca3af',
  tag: '#10b981',
};

const DEFAULT_GROUP_COLORS_LIGHT: Record<GraphGroup, string> = {
  soul: '#0d7bb8',
  user: '#0d7bb8',
  memory: '#0d7bb8',
  core: '#0d7bb8',
  feature: '#047857',
  task: '#b45309',
  knowledge: '#6d28d9',
  release: '#be185d',
  inbox: '#475569',
  tag: '#047857',
};

// Runtime node — force-graph mutates x/y/vx/vy
interface RuntimeNode extends GraphNode {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
  __inDegree?: number;
  __totalDegree?: number;
  __color?: string;
}

type RuntimeLink = Omit<GraphLink, 'source' | 'target'> & {
  source: string | RuntimeNode;
  target: string | RuntimeNode;
};

export interface BrainPageProps {
  onNavigate?: (page: BrainNavigatePage, nodeId: string) => void;
}

function linkEndpointId(endpoint: string | RuntimeNode): string {
  return typeof endpoint === 'string' ? endpoint : endpoint.id;
}

function baseNodeVal(node: RuntimeNode): number {
  const baseline =
    node.group === 'soul' ? 8
    : node.group === 'user' || node.group === 'memory' ? 6
    : node.group === 'tag' ? 3
    : 4;
  const inDeg = node.__inDegree ?? 0;
  return baseline + Math.min(14, inDeg * 1.2);
}

function nodeRadius(node: RuntimeNode, scale: number): number {
  // ForceGraph2D renders radius ≈ sqrt(nodeVal) * nodeRelSize (3 here).
  return Math.sqrt(baseNodeVal(node) * scale) * 3;
}

function colorForNode(
  node: GraphNode,
  userGroups: Array<{ group: GraphColorGroup; parsed: ParsedQuery }>,
  defaults: Record<GraphGroup, string>,
): string {
  for (const { group, parsed } of userGroups) {
    if (parsed.match(node)) return group.color;
  }
  return defaults[node.group];
}

export function BrainPage({ onNavigate }: BrainPageProps) {
  const { data, isLoading, error } = useGraph();
  const queryClient = useQueryClient();
  const { settings, patch, setGroups, reset } = useGraphSettings();
  const { resolved: theme } = useTheme();
  const isDark = theme === 'dark';
  const defaultColors = isDark ? DEFAULT_GROUP_COLORS_DARK : DEFAULT_GROUP_COLORS_LIGHT;

  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(undefined);
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(true);
  const hasFittedRef = useRef(false);

  // Resize observer
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const update = () => setDims({ w: el.clientWidth, h: el.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Parse search query and user color-group queries
  const parsedSearch = useMemo(
    () => parseQuery(settings.filters.search),
    [settings.filters.search],
  );
  const parsedGroups = useMemo(
    () =>
      settings.groups
        .map((g) => ({ group: g, parsed: parseQuery(g.query) }))
        .filter(({ parsed }) => !parsed.isEmpty),
    [settings.groups],
  );

  // ─── Filtered runtime graph ──────────────────────────────────────────
  const { filteredData, neighborsById, totalDegreeById, inDegreeById } = useMemo(() => {
    if (!data) {
      return {
        filteredData: { nodes: [] as RuntimeNode[], links: [] as RuntimeLink[] },
        neighborsById: new Map<string, Set<string>>(),
        totalDegreeById: new Map<string, number>(),
        inDegreeById: new Map<string, number>(),
      };
    }

    // First pass: compute in/out degrees on the full graph (for node sizing)
    const fullInDegree = new Map<string, number>();
    const fullTotalDegree = new Map<string, number>();
    for (const n of data.nodes) {
      fullInDegree.set(n.id, 0);
      fullTotalDegree.set(n.id, 0);
    }
    for (const l of data.links) {
      const s = typeof l.source === 'string' ? l.source : (l.source as GraphNode).id;
      const t = typeof l.target === 'string' ? l.target : (l.target as GraphNode).id;
      fullInDegree.set(t, (fullInDegree.get(t) ?? 0) + 1);
      fullTotalDegree.set(s, (fullTotalDegree.get(s) ?? 0) + 1);
      fullTotalDegree.set(t, (fullTotalDegree.get(t) ?? 0) + 1);
    }

    // Orphans: nodes with zero connections in the full graph
    const isOrphan = (id: string) => (fullTotalDegree.get(id) ?? 0) === 0;

    const visibleNodes: RuntimeNode[] = [];
    const keptIds = new Set<string>();
    for (const n of data.nodes) {
      if (!settings.filters.showTags && n.group === 'tag') continue;
      if (!settings.filters.showOrphans && isOrphan(n.id)) continue;
      // "Existing files only" — in our world all nodes exist, so this is a no-op.
      // "Attachments" — we don't emit attachment nodes, so this is a no-op too.
      if (!parsedSearch.isEmpty && !parsedSearch.match(n)) continue;

      const rn: RuntimeNode = { ...n };
      rn.__inDegree = fullInDegree.get(n.id) ?? 0;
      rn.__totalDegree = fullTotalDegree.get(n.id) ?? 0;
      rn.__color = colorForNode(n, parsedGroups, defaultColors);
      visibleNodes.push(rn);
      keptIds.add(n.id);
    }

    const visibleLinks: RuntimeLink[] = [];
    const neighbors = new Map<string, Set<string>>();
    for (const n of visibleNodes) neighbors.set(n.id, new Set());

    for (const l of data.links) {
      const s = typeof l.source === 'string' ? l.source : (l.source as RuntimeNode).id;
      const t = typeof l.target === 'string' ? l.target : (l.target as RuntimeNode).id;
      if (!keptIds.has(s) || !keptIds.has(t)) continue;
      visibleLinks.push({ source: s, target: t, kind: l.kind });
      neighbors.get(s)!.add(t);
      neighbors.get(t)!.add(s);
    }

    return {
      filteredData: { nodes: visibleNodes, links: visibleLinks },
      neighborsById: neighbors,
      totalDegreeById: fullTotalDegree,
      inDegreeById: fullInDegree,
    };
  }, [data, settings.filters, parsedSearch, parsedGroups]);

  // Apply force settings (charge/link/center/collide/x/y) to the simulation
  const forces = useMemo(() => mapForces(settings.forces), [settings.forces]);
  const nodeSizeScale = 0.4 + settings.display.nodeSize * 2.2; // mirror of nodeVal below

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    const charge = fg.d3Force?.('charge') as unknown as
      | { strength?: (v: number) => void; distanceMax?: (v: number) => void }
      | undefined;
    if (charge?.strength) charge.strength(forces.repelStrength);
    // Clamp repel range so orphans don't get pushed to infinity.
    if (charge?.distanceMax) charge.distanceMax(420);

    const linkForce = fg.d3Force?.('link') as unknown as
      | { strength?: (v: number) => void; distance?: (v: number) => void }
      | undefined;
    if (linkForce) {
      linkForce.strength?.(forces.linkStrength);
      linkForce.distance?.(forces.linkDistance);
    }

    const center = fg.d3Force?.('center') as unknown as
      | { strength?: (v: number) => void }
      | undefined;
    if (center?.strength) center.strength(forces.centerStrength);

    // ─── Custom forces (not exposed by react-force-graph defaults) ─────
    // Collision: prevents overlap, radius proportional to visual node size.
    fg.d3Force?.(
      'collide',
      forceCollide()
        .radius((n: RuntimeNode) => nodeRadius(n, nodeSizeScale) + 4)
        .strength(0.9)
        .iterations(2),
    );
    // Mild x/y pull: keeps orphans from drifting far from center.
    fg.d3Force?.('x', forceX(0).strength(forces.centerStrength * 0.4));
    fg.d3Force?.('y', forceY(0).strength(forces.centerStrength * 0.4));

    fg.d3ReheatSimulation?.();
  }, [forces, nodeSizeScale, filteredData]);

  // Reset the auto-fit flag when the node set changes so a fresh load refits.
  useEffect(() => {
    hasFittedRef.current = false;
  }, [data?.nodes.length]);

  // Fallback fit: even if onEngineStop doesn't fire (e.g. simulation still
  // running when the initial load settles visually), fit after a short delay.
  useEffect(() => {
    if (!data || !filteredData.nodes.length) return;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    [800, 1600, 2600].forEach((ms) => {
      timeouts.push(
        setTimeout(() => {
          if (hasFittedRef.current) return;
          const fg = fgRef.current;
          if (!fg) return;
          fg.zoomToFit?.(500, 80);
          if (ms >= 2600) hasFittedRef.current = true;
        }, ms),
      );
    });
    return () => timeouts.forEach(clearTimeout);
  }, [data, filteredData.nodes.length]);

  const selectedNode = useMemo(
    () => filteredData.nodes.find((n) => n.id === selectedId) ?? null,
    [filteredData, selectedId],
  );

  const relatedToSelected = useMemo(() => {
    if (!selectedNode || !data) return [] as Array<{ node: GraphNode; kind: string }>;
    const rows: Array<{ node: GraphNode; kind: string }> = [];
    const byId = new Map(data.nodes.map((n) => [n.id, n]));
    for (const l of data.links) {
      const s = typeof l.source === 'string' ? l.source : (l.source as GraphNode).id;
      const t = typeof l.target === 'string' ? l.target : (l.target as GraphNode).id;
      if (s === selectedNode.id) {
        const other = byId.get(t);
        if (other) rows.push({ node: other, kind: l.kind });
      } else if (t === selectedNode.id) {
        const other = byId.get(s);
        if (other) rows.push({ node: other, kind: l.kind });
      }
    }
    return rows;
  }, [data, selectedNode]);

  const handleNodeClick = (node: RuntimeNode) => {
    setSelectedId(node.id);
    const fg = fgRef.current;
    if (fg && typeof node.x === 'number' && typeof node.y === 'number') {
      fg.centerAt(node.x, node.y, 400);
      fg.zoom(Math.max(fg.zoom(), 2.2), 400);
    }
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['graph'] });

  // Keyboard: +/- zoom, arrow keys pan
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.matches('input,textarea')) return;
      const fg = fgRef.current;
      if (!fg) return;
      const zoom = fg.zoom();
      if (e.key === '+' || e.key === '=') {
        fg.zoom(zoom * 1.2, 200);
      } else if (e.key === '-' || e.key === '_') {
        fg.zoom(zoom / 1.2, 200);
      } else if (e.key.startsWith('Arrow')) {
        const step = e.shiftKey ? 120 : 40;
        const center = fg.centerAt();
        let dx = 0;
        let dy = 0;
        if (e.key === 'ArrowUp') dy = -step;
        else if (e.key === 'ArrowDown') dy = step;
        else if (e.key === 'ArrowLeft') dx = -step;
        else if (e.key === 'ArrowRight') dx = step;
        fg.centerAt((center?.x ?? 0) + dx / zoom, (center?.y ?? 0) + dy / zoom, 150);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // ─── Rendering ───────────────────────────────────────────────────────
  const active = hoverId ?? selectedId;
  const activeNeighbors = active ? neighborsById.get(active) ?? new Set<string>() : null;

  const isDimmed = (id: string): boolean => {
    if (!active) return false;
    if (id === active) return false;
    return !activeNeighbors?.has(id);
  };

  const nodeColor = (node: RuntimeNode): string => {
    const base = node.__color ?? defaultColors[node.group];
    if (isDimmed(node.id)) return dimHex(base, isDark ? 0.18 : 0.3);
    return base;
  };

  const linkColor = (link: RuntimeLink): string => {
    const s = linkEndpointId(link.source);
    const t = linkEndpointId(link.target);
    if (!active) {
      return isDark ? 'rgba(140, 150, 170, 0.35)' : 'rgba(60, 65, 80, 0.28)';
    }
    if (s === active || t === active) {
      return isDark ? 'rgba(220, 225, 240, 0.85)' : 'rgba(30, 35, 50, 0.85)';
    }
    return isDark ? 'rgba(140, 150, 170, 0.07)' : 'rgba(60, 65, 80, 0.06)';
  };

  const baseLinkWidth = 0.5 + settings.display.linkThickness * 2.5; // 0.5 .. 3
  const linkWidth = (link: RuntimeLink): number => {
    if (link.kind === 'sibling_core' || link.kind === 'release_includes') return baseLinkWidth * 1.3;
    return baseLinkWidth;
  };

  // Obsidian-style node size: proportional to incoming links, scaled by Node-size slider.
  const nodeVal = (node: RuntimeNode): number => baseNodeVal(node) * nodeSizeScale;

  // Text-fade threshold: default 0.85 maps to cutoff ≈0.12, i.e. labels stay
  // visible at basically any normal zoom level. Drag slider to 0 to hide them.
  const zoomToShowLabels = (1 - settings.display.textFadeThreshold) * 0.8; // 0.8 .. 0

  return (
    <div className="brain-page">
      <header className="brain-header">
        <h1 className="brain-title">
          <span className="brain-title-mark">◉</span>
          Brain
        </h1>
        {data && (
          <span className="brain-stats">
            {filteredData.nodes.length}/{data.nodes.length} nodes · {filteredData.links.length} links
          </span>
        )}
        <div className="brain-header-actions">
          <button className="brain-btn" onClick={refresh} title="Refresh">
            ↻
          </button>
          <button
            className={`brain-btn ${settingsOpen ? 'brain-btn--active' : ''}`}
            onClick={() => setSettingsOpen((s) => !s)}
            title="Graph settings"
          >
            ⚙
          </button>
        </div>
      </header>

      <div
        className="brain-canvas-wrap"
        ref={containerRef}
        onPointerLeave={() => setHoverId(null)}
        onPointerDown={() => setHoverId(null)}
      >
        {settingsOpen && (
          <BrainSettings
            settings={settings}
            patch={patch}
            setGroups={setGroups}
            reset={reset}
            onClose={() => setSettingsOpen(false)}
          />
        )}

        {isLoading && <div className="brain-loading">Loading brain…</div>}
        {error && <div className="brain-empty">Failed to load graph: {String(error)}</div>}
        {data && filteredData.nodes.length === 0 && !isLoading && (
          <div className="brain-empty">No nodes match the current filters.</div>
        )}
        {data && filteredData.nodes.length > 0 && dims.w > 0 && (
          <ForceGraph2D<RuntimeNode, RuntimeLink>
            ref={fgRef}
            graphData={filteredData as unknown as Graph}
            width={dims.w}
            height={dims.h}
            backgroundColor={isDark ? '#151518' : '#ffffff'}
            nodeId="id"
            nodeLabel={(n: RuntimeNode) => n.label}
            nodeColor={(n: RuntimeNode) => nodeColor(n)}
            nodeVal={(n: RuntimeNode) => nodeVal(n)}
            nodeRelSize={3}
            linkColor={(l: RuntimeLink) => linkColor(l)}
            linkWidth={(l: RuntimeLink) => linkWidth(l)}
            linkDirectionalArrowLength={(_l: RuntimeLink) => (settings.display.arrows ? 3.5 : 0)}
            linkDirectionalArrowRelPos={0.94}
            linkDirectionalArrowColor={() =>
              isDark ? 'rgba(180, 185, 200, 0.6)' : 'rgba(60, 65, 80, 0.55)'
            }
            onNodeClick={(n: RuntimeNode) => handleNodeClick(n)}
            onNodeHover={(n: RuntimeNode | null) => setHoverId(n ? n.id : null)}
            onNodeDrag={() => setHoverId(null)}
            onZoom={() => setHoverId(null)}
            onBackgroundClick={() => {
              setSelectedId(null);
              setHoverId(null);
            }}
            onEngineStop={() => {
              if (hasFittedRef.current) return;
              const fg = fgRef.current;
              if (!fg) return;
              // Fit all nodes with 80px padding, animated over 600ms.
              fg.zoomToFit?.(600, 80);
              hasFittedRef.current = true;
            }}
            cooldownTicks={160}
            d3AlphaDecay={0.025}
            d3VelocityDecay={0.28}
            enableNodeDrag
            nodeCanvasObjectMode={() => 'after'}
            nodeCanvasObject={(
              node: RuntimeNode,
              ctx: CanvasRenderingContext2D,
              globalScale: number,
            ) => {
              // Label fade — show only when zoomed in past threshold, except
              // for the hovered/selected node and its neighbors (always visible).
              const alwaysShow =
                node.id === hoverId ||
                node.id === selectedId ||
                (active && activeNeighbors?.has(node.id));
              if (!alwaysShow && globalScale < zoomToShowLabels) return;

              const label = node.label;
              const fontSize = Math.max(10, 13 / Math.max(globalScale, 0.7));
              ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, 'Visby CF', sans-serif`;
              ctx.textAlign = 'center';
              ctx.textBaseline = 'top';
              const radius = nodeRadius(node, nodeSizeScale);
              const y = (node.y ?? 0) + radius + 3;
              const dimmed = isDimmed(node.id);
              if (isDark) {
                ctx.fillStyle = dimmed ? 'rgba(200, 210, 225, 0.3)' : 'rgba(235, 240, 250, 0.95)';
              } else {
                ctx.fillStyle = dimmed ? 'rgba(60, 65, 80, 0.3)' : 'rgba(20, 24, 36, 0.92)';
              }
              ctx.fillText(label, node.x ?? 0, y);
            }}
          />
        )}

        {/* Obsidian doesn't show a legend — colors are controlled via the Groups
            section in the settings panel. Leaving this out for parity. */}

        <NodeDrawer
          node={selectedNode}
          onClose={() => setSelectedId(null)}
          onSelectRelated={(id) => setSelectedId(id)}
          relatedNodes={relatedToSelected}
          inDegree={selectedNode ? inDegreeById.get(selectedNode.id) ?? 0 : 0}
          totalDegree={selectedNode ? totalDegreeById.get(selectedNode.id) ?? 0 : 0}
          onNavigate={onNavigate}
        />
      </div>
    </div>
  );
}

function dimHex(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const bigint = parseInt(h, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
