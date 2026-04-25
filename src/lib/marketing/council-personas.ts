/**
 * Locate + load the bundled marketing council personas.
 *
 * Personas live as data files at `skill-packs/meta-marketing/council-personas/*.md`
 * (per architect MUST-CHANGE 6: NOT a `--preset` flag on the council command).
 * They are shipped via tsup `cpSync('skill-packs', 'dist/skill-packs', ...)`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import matter from 'gray-matter';

const __dirname_local = (() => {
  try { return dirname(fileURLToPath(import.meta.url)); } catch { return process.cwd(); }
})();

export interface MarketingPersona {
  slug: string;
  model: string;
  aspects: string[];
  body: string;       // Persona body markdown (frontmatter stripped).
  filePath: string;   // Absolute path to the source file (debug aid).
}

const VALID_MODELS = new Set(['opus', 'sonnet', 'haiku']);
const PERSONA_SUBPATH = join('skill-packs', 'meta-marketing', 'council-personas');

/**
 * Locate the bundled personas dir by walking up from this module's own location.
 * Mirrors the resolution pattern in `install-skill.ts::findPackageDir`.
 */
export function findPersonasDir(): string | null {
  const candidates = [
    // dev:   src/lib/marketing/council-personas.ts → ../../../skill-packs/...
    join(__dirname_local, '..', '..', '..', PERSONA_SUBPATH),
    // built: dist/index.js → ./skill-packs/...
    join(__dirname_local, PERSONA_SUBPATH),
    // tsup-bundled (deeper nesting if ever): ../skill-packs/...
    join(__dirname_local, '..', PERSONA_SUBPATH),
    join(__dirname_local, '..', '..', PERSONA_SUBPATH),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Parse a persona file. Throws on malformed frontmatter or invalid model.
 */
export function parsePersonaFile(filePath: string): MarketingPersona {
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = matter(raw);
  const data = parsed.data as Record<string, unknown>;

  const slug = typeof data.slug === 'string' ? data.slug.trim() : '';
  if (!/^[a-z][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Invalid persona slug in ${filePath}: ${JSON.stringify(data.slug)}`);
  }

  const model = typeof data.model === 'string' ? data.model.trim() : '';
  if (!VALID_MODELS.has(model)) {
    throw new Error(`Invalid persona model in ${filePath}: ${JSON.stringify(data.model)} (expected opus|sonnet|haiku)`);
  }

  const aspects = Array.isArray(data.aspects)
    ? data.aspects.map((a) => String(a).trim()).filter(Boolean)
    : [];

  const body = parsed.content.trim();
  if (body.length === 0) {
    throw new Error(`Persona body is empty in ${filePath}`);
  }

  return { slug, model, aspects, body, filePath };
}

/**
 * Load all personas from the bundled directory. Returns [] if the dir is
 * missing (caller should surface a "reinstall dreamcontext" error).
 */
export function loadAllPersonas(personasDir?: string): MarketingPersona[] {
  const dir = personasDir ?? findPersonasDir();
  if (!dir || !existsSync(dir)) return [];

  const files = readdirSync(dir).filter((n) => n.endsWith('.md')).sort();
  return files.map((name) => parsePersonaFile(join(dir, name)));
}

/**
 * Filter personas by an explicit slug list. Throws if any requested slug is
 * not present in the loaded set.
 */
export function selectPersonas(
  all: readonly MarketingPersona[],
  requested: readonly string[],
): MarketingPersona[] {
  if (requested.length === 0) return [...all];
  const known = new Map(all.map((p) => [p.slug, p]));
  const missing = requested.filter((s) => !known.has(s));
  if (missing.length > 0) {
    const available = all.map((p) => p.slug).join(', ');
    throw new Error(`Unknown persona slug(s): ${missing.join(', ')}. Available: ${available}`);
  }
  return requested.map((s) => known.get(s)!);
}
