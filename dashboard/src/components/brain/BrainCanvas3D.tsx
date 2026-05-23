import { useEffect, useMemo, useRef } from 'react';
import ForceGraph3D from 'react-force-graph-3d';
import * as THREE from 'three';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — d3-force-3d has no bundled types
import { forceCollide, forceX, forceY, forceZ } from 'd3-force-3d';
import type { Graph, GraphNode, GraphLink } from '../../hooks/useGraph';

// Runtime augmentation — duplicated from BrainPage to avoid a circular import.
// force-graph mutates x/y/z/vx/vy/vz on nodes during simulation.
interface RuntimeNode extends GraphNode {
  x?: number;
  y?: number;
  z?: number;
  vx?: number;
  vy?: number;
  vz?: number;
  fx?: number | null;
  fy?: number | null;
  fz?: number | null;
  __inDegree?: number;
  __totalDegree?: number;
  __color?: string;
}

type RuntimeLink = Omit<GraphLink, 'source' | 'target'> & {
  source: string | RuntimeNode;
  target: string | RuntimeNode;
};

export interface BrainCanvas3DProps {
  graphData: { nodes: RuntimeNode[]; links: RuntimeLink[] };
  width: number;
  height: number;
  isDark: boolean;
  nodeColor: (n: RuntimeNode) => string;
  nodeVal: (n: RuntimeNode) => number;
  linkColor: (l: RuntimeLink) => string;
  linkWidth: (l: RuntimeLink) => number;
  showArrows: boolean;
  forces: {
    centerStrength: number;
    repelStrength: number;
    linkStrength: number;
    linkDistance: number;
  };
  nodeSizeScale: number;
  isDimmed: (id: string) => boolean;
  /** Adjacency map for camera framing on click — clicked node + its
   *  immediate neighbors are fit into view together (the connected subtree). */
  neighborsById: Map<string, Set<string>>;
  onNodeClick: (n: RuntimeNode) => void;
  onNodeHover: (n: RuntimeNode | null) => void;
  onBackgroundClick: () => void;
}

function nodeRadius3D(node: RuntimeNode, scale: number): number {
  // ForceGraph3D node sphere radius ≈ cbrt(nodeVal) * nodeRelSize (4 here).
  return Math.cbrt(Math.max(0.1, nodeVal(node, scale))) * 4;
}

function nodeVal(node: RuntimeNode, scale: number): number {
  const baseline =
    node.group === 'soul' ? 8
    : node.group === 'user' || node.group === 'memory' ? 6
    : node.group === 'tag' ? 3
    : 4;
  const inDeg = node.__inDegree ?? 0;
  return (baseline + Math.min(14, inDeg * 1.2)) * scale;
}

function makeLabelSprite(text: string, color: string, dpr: number): THREE.Sprite {
  // Render canvas at hi-res for crisp text, but project at small world scale.
  const fontPx = 22;
  const padX = 6;
  const padY = 4;
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, 'Visby CF', sans-serif`;
  const textWidth = Math.ceil(probe.measureText(text).width);

  const canvasW = (textWidth + padX * 2) * dpr;
  const canvasH = (fontPx + padY * 2) * dpr;
  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.font = `600 ${fontPx}px -apple-system, BlinkMacSystemFont, 'Visby CF', sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  ctx.fillText(text, padX, fontPx / 2 + padY);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    depthTest: true,  // respect depth — far labels can be occluded by near nodes
    fog: true,        // fade label opacity with scene fog
  });
  const sprite = new THREE.Sprite(material);
  // World-units per CSS pixel — much smaller than before so labels don't
  // dominate the scene. Cube-root keeps long labels from being huge.
  const scale = 0.18;
  sprite.scale.set((textWidth + padX * 2) * scale, (fontPx + padY * 2) * scale, 1);
  return sprite;
}

export function BrainCanvas3D({
  graphData,
  width,
  height,
  isDark,
  nodeColor,
  linkColor,
  linkWidth,
  showArrows,
  forces,
  nodeSizeScale,
  isDimmed,
  neighborsById,
  onNodeClick,
  onNodeHover,
  onBackgroundClick,
}: BrainCanvas3DProps) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fgRef = useRef<any>(undefined);
  const hasFittedRef = useRef(false);
  const dpr = useMemo(
    () => (typeof window !== 'undefined' ? Math.min(2, window.devicePixelRatio || 1) : 1),
    [],
  );

  // Reset auto-fit when the node set changes.
  useEffect(() => {
    hasFittedRef.current = false;
  }, [graphData.nodes.length]);

  // Apply force config + custom 3D forces.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;

    const charge = fg.d3Force?.('charge');
    if (charge?.strength) charge.strength(forces.repelStrength);
    if (charge?.distanceMax) charge.distanceMax(520);

    const linkForce = fg.d3Force?.('link');
    if (linkForce) {
      linkForce.strength?.(forces.linkStrength);
      linkForce.distance?.(forces.linkDistance);
    }

    const center = fg.d3Force?.('center');
    if (center?.strength) center.strength(forces.centerStrength);

    fg.d3Force?.(
      'collide',
      forceCollide()
        .radius((n: RuntimeNode) => nodeRadius3D(n, nodeSizeScale) + 4)
        .strength(0.9)
        .iterations(2),
    );
    fg.d3Force?.('x', forceX(0).strength(forces.centerStrength * 0.35));
    fg.d3Force?.('y', forceY(0).strength(forces.centerStrength * 0.35));
    fg.d3Force?.('z', forceZ(0).strength(forces.centerStrength * 0.35));

    fg.d3ReheatSimulation?.();
  }, [forces, nodeSizeScale, graphData]);

  // Auto-fit on first settle.
  useEffect(() => {
    if (!graphData.nodes.length) return;
    const timeouts: ReturnType<typeof setTimeout>[] = [];
    [900, 1800, 2800].forEach((ms) => {
      timeouts.push(
        setTimeout(() => {
          if (hasFittedRef.current) return;
          const fg = fgRef.current;
          if (!fg) return;
          fg.zoomToFit?.(700, 80);
          if (ms >= 2800) hasFittedRef.current = true;
        }, ms),
      );
    });
    return () => timeouts.forEach(clearTimeout);
  }, [graphData.nodes.length]);

  // Scene fog — gives near/far depth perception WITHOUT hiding the scene.
  // ForceGraph3D auto-fit can place the camera 1500-3000 units from origin
  // for a ~100-node graph, so the fog far plane must be very generous.
  // Near is set fairly large too: nothing inside the cluster gets a heavy
  // fog tint, depth cue only kicks in for the back of the bbox.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const scene = fg.scene?.();
    if (!scene) return;
    const fogColor = isDark ? 0x0d0d10 : 0xf7f7fa;
    scene.fog = new THREE.Fog(fogColor, 900, 4200);
  }, [isDark, graphData.nodes.length]);

  // Click → frame the clicked node TOGETHER WITH its immediate neighbors so
  // the connected subtree dominates the viewport. We compute the bbox of
  // the focused set ourselves and place the camera at a distance that just
  // contains it (with a small padding factor). `zoomToFit` with a filter
  // didn't behave reliably here — the library kept the camera at its
  // current far distance even though the bbox was small, so we drive
  // `cameraPosition` directly.
  const handleNodeClickInternal = (n: RuntimeNode) => {
    onNodeClick(n);
    const fg = fgRef.current;
    if (!fg) return;

    const neighbors = neighborsById.get(n.id) ?? new Set<string>();
    const focusIds = new Set<string>([n.id, ...neighbors]);
    const focused = graphData.nodes.filter(
      (node) =>
        focusIds.has(node.id) &&
        typeof node.x === 'number' &&
        typeof node.y === 'number' &&
        typeof node.z === 'number',
    );

    if (focused.length === 0) return;

    // Centroid + max half-extent → radius of bounding sphere around the subtree.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const node of focused) {
      const x = node.x as number;
      const y = node.y as number;
      const z = node.z as number;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const half = Math.max(maxX - minX, maxY - minY, maxZ - minZ) / 2;
    // For a single isolated node, half=0 → fall back to a fixed close distance.
    // For a subtree, distance scales with bbox so 3 close nodes get close in
    // and 8 spread-out nodes get further out. fov = 50° (ForceGraph3D default).
    const fov = 50;
    const minDist = 90;   // never closer than this (single node case)
    const padFactor = 2.2; // generous padding around the subtree
    const fitDist = (half / Math.tan((fov * Math.PI) / 360)) * padFactor;
    const targetDist = Math.max(minDist, fitDist);

    // Keep the camera along its current viewing direction toward the subtree
    // centroid so the user's orbit orientation is preserved.
    const camera = fg.camera?.();
    let dx = 0, dy = 0, dz = 1;
    if (camera) {
      dx = camera.position.x - cx;
      dy = camera.position.y - cy;
      dz = camera.position.z - cz;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
    }

    fg.cameraPosition?.(
      { x: cx + dx * targetDist, y: cy + dy * targetDist, z: cz + dz * targetDist },
      { x: cx, y: cy, z: cz },
      900,
    );
  };

  return (
    <ForceGraph3D<RuntimeNode, RuntimeLink>
      ref={fgRef}
      graphData={graphData as unknown as Graph}
      width={width}
      height={height}
      backgroundColor={isDark ? '#0d0d10' : '#f7f7fa'}
      showNavInfo={false}
      nodeId="id"
      nodeLabel={(n: RuntimeNode) => n.label}
      nodeColor={(n: RuntimeNode) => nodeColor(n)}
      nodeVal={(n: RuntimeNode) => nodeVal(n, nodeSizeScale)}
      nodeRelSize={4}
      nodeOpacity={0.92}
      nodeResolution={16}
      linkColor={(l: RuntimeLink) => linkColor(l)}
      linkWidth={(l: RuntimeLink) => linkWidth(l)}
      linkOpacity={0.55}
      linkDirectionalArrowLength={(_l: RuntimeLink) => (showArrows ? 3.5 : 0)}
      linkDirectionalArrowRelPos={0.94}
      linkDirectionalArrowColor={() =>
        isDark ? 'rgba(180, 185, 200, 0.7)' : 'rgba(60, 65, 80, 0.7)'
      }
      onNodeClick={(n: RuntimeNode) => handleNodeClickInternal(n)}
      onNodeHover={(n: RuntimeNode | null) => onNodeHover(n)}
      onBackgroundClick={onBackgroundClick}
      cooldownTicks={180}
      d3AlphaDecay={0.025}
      d3VelocityDecay={0.3}
      enableNodeDrag
      enableNavigationControls
      controlType="orbit"
      nodeThreeObjectExtend={true}
      nodeThreeObject={(node: RuntimeNode) => {
        const baseColor = nodeColor(node);
        const dimmed = isDimmed(node.id);
        const labelColor = dimmed
          ? (isDark ? 'rgba(200, 210, 225, 0.35)' : 'rgba(60, 65, 80, 0.35)')
          : (isDark ? '#eaf0fa' : '#141826');
        const sprite = makeLabelSprite(node.label, labelColor, dpr);
        // Position label below the node sphere.
        const r = nodeRadius3D(node, nodeSizeScale);
        sprite.position.set(0, -(r + 5), 0);
        // Use baseColor to keep tree-shaker happy / future hover ring tinting.
        sprite.userData.baseColor = baseColor;
        return sprite;
      }}
    />
  );
}
