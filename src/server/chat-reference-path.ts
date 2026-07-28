import { statSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Where a path WRITTEN IN A TRANSCRIPT actually lives.
 *
 * A reference in a chat answer is not a filesystem argument — it is a name the model typed,
 * and the model's `../..` counting is the least reliable part of it. The owner's 07-28 report
 * is the canonical case: an answer wrote
 *
 *     ![Automations empty state](../../tmp/dc-verify-auto/automations-light.png)
 *
 * for a screenshot really sitting at `/tmp/dc-verify-auto/automations-light.png`. Anchored at
 * the project root that climbs to `~/tmp/dc-verify-auto/…`, which is nowhere. Every surface
 * downstream then had nothing to work with: the picture couldn't be drawn, the fallback card's
 * "Open ↗" couldn't open, and the user got a chip that did nothing.
 *
 * So a reference is resolved the way a person would resolve it — by what it NAMES, not by
 * where its `..`s point:
 *
 *   1. literally, anchored at the project root (an absolute path passes straight through);
 *   2. failing that, by matching its TAIL against a fixed, small list of roots — the project,
 *      the project's own scratch and drop dirs, and the system temp dirs, which is where an
 *      agent's screenshots and recordings are actually written. Longest tail first, so the
 *      most specific match wins.
 *
 * Two rules keep step 2 from ever guessing wrong in a way that matters:
 *
 *   • outside a project-scoped root, a tail must carry at least one DIRECTORY segment.
 *     `dc-verify-auto/automations-light.png` may match under `/tmp`; a bare `notes.txt` may
 *     not, because half the machines in the world have a `/tmp/notes.txt` that is not the
 *     file the answer meant. Inside the project's own dirs a bare name is meaningful, so it
 *     is allowed there.
 *   • the roots are a fixed allowlist and `/` is not among them, so no amount of `..` in a
 *     reference reaches an arbitrary place on disk by this route.
 *
 * Resolving is NOT permission. Whatever comes back is still subject to the caller's own
 * rules — `/agent/file` will not SERVE an `outside` result without the user's explicit
 * per-file grant, and `/agent/reveal` still refuses to launch an executable. This function
 * only answers "which file is that?".
 *
 * Bounded and stat-only: at most (segments × roots) direct `statSync` calls, no directory
 * walking, no recursion.
 */

export interface ResolvedReference {
  /** The absolute path the reference names. When `missing`, the literal interpretation. */
  abs: string;
  /** Outside the project root — servable only with the user's explicit grant. */
  outside: boolean;
  /** The literal path did not exist and this was found by matching the reference's tail. */
  recovered: boolean;
  /** Nothing exists at `abs`, and nothing matched the tail either. */
  missing: boolean;
}

/** Directories a reference's tail may be matched against, in order of preference. */
function searchRoots(
  projectRoot: string,
  contextRoot: string | null | undefined,
): Array<{ dir: string; projectScoped: boolean }> {
  const roots = [
    { dir: projectRoot, projectScoped: true },
    ...(contextRoot ? [
      { dir: join(contextRoot, 'tmp'), projectScoped: true },
      { dir: join(contextRoot, 'tmp', 'agent-drops'), projectScoped: true },
      { dir: join(contextRoot, 'assets'), projectScoped: true },
    ] : []),
    { dir: tmpdir(), projectScoped: false },
    { dir: '/tmp', projectScoped: false },
  ];
  // `tmpdir()` IS `/tmp` on most Linux boxes and a private per-user dir on macOS — dedupe so
  // the same directory is never stat'ed twice per tail.
  const seen = new Set<string>();
  return roots.filter((r) => {
    const key = resolve(r.dir);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function exists(p: string): boolean {
  try { statSync(p); return true; } catch { return false; }
}

function isInside(root: string, abs: string): boolean {
  return abs === root || abs.startsWith(root + sep);
}

export function resolveChatReference(
  projectRoot: string | null | undefined,
  contextRoot: string | null | undefined,
  rawPath: string,
): ResolvedReference | null {
  // A null byte is not a mistyped path, it is an attempt to end one early — never resolved,
  // never recovered, never guessed at.
  if (!rawPath || rawPath.includes('\0')) return null;

  // No project to anchor to (no vault resolved for this request): only an ALREADY absolute
  // reference means anything. Anchoring on the server PROCESS's cwd is precisely the bug
  // this module exists to end — for a desktop-spawned server that directory is not the
  // project, and every relative path silently resolved somewhere meaningless.
  if (!projectRoot) {
    if (!isAbsolute(rawPath)) return null;
    const abs = resolve(rawPath);
    return { abs, outside: true, recovered: false, missing: !exists(abs) };
  }

  const root = resolve(projectRoot);
  const literal = resolve(root, rawPath);
  if (exists(literal)) {
    return { abs: literal, outside: !isInside(root, literal), recovered: false, missing: false };
  }

  // The reference's own segments, with the unreliable part — the leading `..`/`.` climb —
  // dropped. What is left is what the answer actually NAMED.
  const segments = rawPath.split('/').filter((s) => s && s !== '.' && s !== '..');
  const roots = searchRoots(root, contextRoot);
  for (let i = 0; i < segments.length; i += 1) {
    const tail = segments.slice(i);
    const multiSegment = tail.length > 1;
    for (const { dir, projectScoped } of roots) {
      if (!multiSegment && !projectScoped) continue; // see this module's header: no bare names outside
      const base = resolve(dir);
      const cand = join(base, ...tail);
      // The tail carries no `..` by construction, but a caller's root could be a symlink or
      // the join could still surprise — containment is asserted, not assumed.
      if (!isInside(base, cand)) continue;
      if (exists(cand)) {
        return { abs: cand, outside: !isInside(root, cand), recovered: true, missing: false };
      }
    }
  }

  return { abs: literal, outside: !isInside(root, literal), recovered: false, missing: true };
}
