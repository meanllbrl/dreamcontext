// Minimal typings for the subset of d3-force-3d the dashboard uses (it ships
// untyped). It is a transitive dependency of react-force-graph-2d, so these
// forces plug into the same simulation instance the graph runs on.
// Node callbacks are `any`-typed on purpose: each call site works with its own
// node shape (RuntimeNode, GNode, …) and the simulation is untyped anyway.
declare module 'd3-force-3d' {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  export interface Force {
    (alpha: number): void;
    initialize?: (nodes: any[], ...args: any[]) => void;
  }
  export interface PositionForce extends Force {
    strength(s: number | ((node: any) => number)): PositionForce;
    x?(v: number | ((node: any) => number)): PositionForce;
    y?(v: number | ((node: any) => number)): PositionForce;
    z?(v: number | ((node: any) => number)): PositionForce;
  }
  export interface CollideForce extends Force {
    radius(r: number | ((node: any) => number)): CollideForce;
    strength(s: number): CollideForce;
    iterations(n: number): CollideForce;
  }
  export function forceX(x?: number): PositionForce;
  export function forceY(y?: number): PositionForce;
  export function forceZ(z?: number): PositionForce;
  export function forceCollide(radius?: number | ((node: any) => number)): CollideForce;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
