/**
 * The agent figure ("B · Rüya"): which of the 8 shapes and 8 identity tones an agent or an
 * automation wears. PURE, no I/O and no Node imports: the dashboard imports this module
 * directly (as it does `tree.ts`), so the face a page draws is the face the store stamped.
 *
 * The rule (owner-approved, `ajan-figur/NOT.md`):
 *  1. key = the slug, trimmed and lowercased (a rename of the title never changes the face);
 *  2. h = FNV-1a 32 of the key, unsigned;
 *  3. shape = h % 8, color = (h >>> 8) % 8: 64 distinct pairs;
 *  4. a pair already worn inside the vault (its agents + automations) moves the newcomer to
 *     color + 1 (mod 8); with all 8 colors of that shape taken, shape + 1 and the colors are
 *     scanned again from the start; past 64 members a collision is allowed;
 *  5. collisions resolve in creation order: the older member keeps its face.
 *
 * The face is STAMPED on the manifest at create (`face: {shape, color}`, unhashed, like
 * `photo`), so adding a member never moves anyone else's face. An unstamped manifest falls back
 * to the bare hash (`agentFigure(slug)` with nothing taken).
 */

export const FIGURE_SHAPES = 8;
export const FIGURE_COLORS = 8;

/** Shape names, in the fixed order whose index IS the shape id. */
export const FIGURE_SHAPE_NAMES = ['pillow', 'crescent', 'mochi', 'bean', 'star', 'loaf', 'egg', 'dreamstone'] as const;
/** Identity tones, in the fixed order whose index IS the color id. No green, no magenta: those
 *  two are state colors (working, asking), and an identity must never read as a state. */
export const FIGURE_TONES = ['violet', 'plum', 'indigo', 'sky', 'teal', 'coral', 'amber', 'rose'] as const;

export type FigureTone = (typeof FIGURE_TONES)[number];

export interface AgentFace {
  shape: number;
  color: number;
}

/** FNV-1a 32-bit over the UTF-8 bytes of `s`, unsigned. */
export function fnv1a32(s: string): number {
  const bytes = new TextEncoder().encode(s);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** `"shape:color"`, the key a taken-set holds. */
export function faceKey(face: AgentFace): string {
  return `${face.shape}:${face.color}`;
}

/** The face the hash alone gives `slug`, ignoring everyone else. */
export function baseFigure(slug: string): AgentFace {
  const h = fnv1a32(slug.trim().toLowerCase());
  return { shape: h % FIGURE_SHAPES, color: (h >>> 8) % FIGURE_COLORS };
}

/**
 * The face `slug` gets in a vault where `taken` (face keys, see {@link faceKey}) are already
 * worn. With every pair taken (a team past 64), the bare hash: a collision is allowed then.
 */
export function agentFigure(slug: string, taken: Iterable<string> = []): AgentFace {
  const base = baseFigure(slug);
  const worn = new Set(taken);
  if (worn.size >= FIGURE_SHAPES * FIGURE_COLORS) return base;
  for (let ds = 0; ds < FIGURE_SHAPES; ds++) {
    const shape = (base.shape + ds) % FIGURE_SHAPES;
    for (let dc = 0; dc < FIGURE_COLORS; dc++) {
      const face = { shape, color: (base.color + dc) % FIGURE_COLORS };
      if (!worn.has(faceKey(face))) return face;
    }
  }
  return base;
}

/** A stored `face:` value, or null unless it is two in-range integers. */
export function parseFace(v: unknown): AgentFace | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const { shape, color } = v as Record<string, unknown>;
  if (!Number.isInteger(shape) || !Number.isInteger(color)) return null;
  const s = shape as number;
  const c = color as number;
  if (s < 0 || s >= FIGURE_SHAPES || c < 0 || c >= FIGURE_COLORS) return null;
  return { shape: s, color: c };
}

/** The face to draw: the stamped one, else the bare hash. */
export function faceOf(slug: string, stamped: AgentFace | null | undefined): AgentFace {
  return stamped ?? baseFigure(slug);
}

/**
 * Faces for a whole vault in creation order (oldest first): members already stamped keep their
 * stamp; each unstamped one gets the next free pair given everyone before it AND every stamped
 * member. Idempotent: running it on its own output changes nothing.
 */
export function assignFigures(
  members: readonly { slug: string; face: AgentFace | null; key?: string }[],
): Map<string, AgentFace> {
  const out = new Map<string, AgentFace>();
  const taken = new Set<string>();
  for (const m of members) if (m.face) taken.add(faceKey(m.face));
  for (const m of members) {
    // Keyed by `key` when given (an agent and its same-slug routine are two members), else the slug.
    const key = m.key ?? m.slug;
    if (m.face) {
      out.set(key, m.face);
      continue;
    }
    const face = agentFigure(m.slug, taken);
    taken.add(faceKey(face));
    out.set(key, face);
  }
  return out;
}
