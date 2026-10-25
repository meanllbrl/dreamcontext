import { lstatSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import fg from 'fast-glob';
import { listManifestFiles, patchManifestFrontmatter, pathOccupied } from '../automations/store.js';
import { assignFigures, faceKey, agentFigure, parseFace, type AgentFace } from './figure.js';
import { parseManifestFrontmatter } from './slot.js';
import { AGENTS_DIR } from './types.js';

/**
 * The figure faces of one vault: every agent file and every automation file, read from disk.
 * The pure rule is `figure.ts`; this module only reads the members and stamps their files.
 *
 * Imports `../automations/store.js`, which imports the agents store back: every use is inside a
 * function body, so the ESM cycle resolves (the same rule `store.ts` follows).
 */

interface Member {
  slug: string;
  path: string;
  face: AgentFace | null;
  /** Published to the team brain (`shared: true`): other machines hold the same file. */
  shared: boolean;
  /** Creation order key: the file's birth time, else 0 (then the slug decides). */
  born: number;
}

function readMember(path: string): Member | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return null;
    const { data } = parseManifestFrontmatter(readFileSync(path, 'utf-8'));
    return { slug: basename(path, '.md'), path, face: parseFace(data.face), shared: data.shared === true, born: st.birthtimeMs || st.mtimeMs || 0 };
  } catch {
    return null;
  }
}

/** Every readable agent and automation file, oldest first (birth time, then slug). */
function vaultMembers(contextRoot: string): Member[] {
  const dir = join(contextRoot, AGENTS_DIR);
  const agentFiles = pathOccupied(dir) ? fg.sync('*.md', { cwd: dir, absolute: true }) : [];
  const members = [...agentFiles, ...listManifestFiles(contextRoot)]
    .map(readMember)
    .filter((m): m is Member => m !== null);
  return members.sort((a, b) => a.born - b.born || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** The face a NEW member named `slug` gets in this vault: the next free pair given everyone already
 *  here (stamped faces as stamped, unstamped ones as the backfill would stamp them). */
export function nextFreeFace(contextRoot: string, slug: string): AgentFace {
  const faces = assignFigures(vaultMembers(contextRoot).map((m) => ({ slug: m.slug, face: m.face, key: m.path })));
  return agentFigure(slug, [...faces.values()].map(faceKey));
}

/**
 * Stamp `face:` on every agent and automation file that has none, in creation order, each taking
 * the next free pair. Idempotent: a vault whose members are all stamped is not written. Returns the
 * files it stamped (absolute). A file that cannot be written is skipped and retried next time.
 *
 * A SHARED file is never stamped here: other machines hold it too, and each would pick its pair
 * from its own members in its own file order, so two machines could write two faces into one
 * synced file. It draws the bare hash of its slug until it is stamped where it is written (create).
 */
export function backfillFaces(contextRoot: string): string[] {
  const members = vaultMembers(contextRoot);
  if (members.every((m) => m.face || m.shared)) return [];
  // Keyed by path, not slug: an agent and its same-slug routine are two members.
  const byPath = new Map(members.map((m) => [m.path, m]));
  const faces = assignFigures(members.map((m) => ({ slug: m.slug, face: m.face, key: m.path })));
  const stamped: string[] = [];
  for (const [path, face] of faces) {
    const member = byPath.get(path);
    if (!member || member.face || member.shared) continue;
    try {
      patchManifestFrontmatter(path, { face: { shape: face.shape, color: face.color } });
      stamped.push(path);
    } catch {
      // a symlinked or unwritable file keeps drawing its bare hash
    }
  }
  return stamped;
}
