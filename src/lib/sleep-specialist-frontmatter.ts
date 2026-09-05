import { createHash } from 'node:crypto';
import matter from 'gray-matter';
import type { SleepSpecialistConfig } from './setup-config.js';

/**
 * sleep-specialist-frontmatter — the pure text surgery behind per-brain sleep
 * specialist models.
 *
 * A brain picks a model/effort per specialist (`.config.json` `sleep.specialists`);
 * Claude Code reads those from each agent file's YAML frontmatter. So the
 * setting has to be INJECTED into `.claude/agents/sleep-*.md` at install time —
 * otherwise the next `install-skill` / `setup` / `update` copies the packaged
 * file over it and silently reverts the choice, which is exactly the failure the
 * umbrella task was filed for.
 *
 * Two jobs, deliberately separate:
 *
 *  - `applySpecialistFrontmatter` PATCHES the two keys textually. Not a
 *    gray-matter round-trip: re-serialising would reflow every other key
 *    (`description: >` folded blocks especially) and produce a diff nobody
 *    asked for. The body is never touched.
 *  - `agentBaselineSha` / `isCustomizedAgent` answer "did a HUMAN edit this
 *    file?" against a baseline recorded at install time. The canonical form
 *    deliberately EXCLUDES `model` and `effort` (they are ours to write) and
 *    normalises key order + line endings, so injecting an override, a CRLF
 *    checkout, or a re-serialised key order can never read as a customization.
 */

/** LF-normalise + strip a trailing-newline difference. */
function normalizeEol(content: string): string {
  return content.split('\r\n').join('\n');
}

/**
 * The comparable form of an agent file: LF line endings, frontmatter re-emitted
 * with sorted keys and WITHOUT `model`/`effort`, then the body verbatim.
 *
 * NEVER THROWS. A frontmatter that does not parse as YAML (a hand edit broke
 * it) falls back to the raw LF-normalised text — which will not equal the
 * recorded baseline, so the file reads as CUSTOMIZED. That is the safe answer:
 * we decline to overwrite a file we cannot understand.
 */
export function canonicalAgentForm(content: string): string {
  const lf = normalizeEol(content);
  try {
    const parsed = matter(lf);
    const data = { ...(parsed.data as Record<string, unknown>) };
    delete data.model;
    delete data.effort;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(data).sort()) sorted[key] = data[key];
    return matter.stringify(parsed.content, sorted);
  } catch {
    return lf;
  }
}

/** sha256 of {@link canonicalAgentForm} — what the install manifest records. */
export function agentBaselineSha(content: string): string {
  return createHash('sha256').update(canonicalAgentForm(content), 'utf-8').digest('hex');
}

/**
 * Has this installed agent been edited by hand since we wrote it?
 *
 * Compared against the baseline RECORDED AT INSTALL, never against the live
 * package: a CLI upgrade ships a new agent body before the project's own
 * `dreamcontext update` runs, and reading that gap as "the user customized it"
 * would pause auto-sleep after every routine refresh.
 *
 * A brain whose manifest predates the field (no baseline) is treated as
 * UNCUSTOMIZED — an upgrade must not produce a false pause.
 */
export function isCustomizedAgent(installed: string, baselineSha: string | undefined): boolean {
  if (!baselineSha) return false;
  return agentBaselineSha(installed) !== baselineSha;
}

/** Where the frontmatter block ends, or -1 when there is no well-formed one. */
function frontmatterBounds(lf: string): { start: number; end: number } | null {
  if (!lf.startsWith('---\n')) return null;
  const end = lf.indexOf('\n---', 3);
  if (end === -1) return null;
  return { start: 4, end: end + 1 };
}

/**
 * Replace (or insert) `model:` and `effort:` in an agent file's frontmatter.
 *
 * Only TOP-LEVEL keys are touched — the scan skips any line that is indented or
 * part of a folded block, so a `model:` mentioned inside `description: >` is
 * left alone. Returns the source unchanged when there is no override to apply
 * or no parseable frontmatter block (a malformed file is never rewritten).
 */
export function applySpecialistFrontmatter(
  source: string,
  override: SleepSpecialistConfig | undefined,
): string {
  if (!override || (override.model === undefined && override.effort === undefined)) return source;
  const lf = normalizeEol(source);
  const bounds = frontmatterBounds(lf);
  if (!bounds) return source;

  const head = lf.slice(0, bounds.start);
  const block = lf.slice(bounds.start, bounds.end);
  const tail = lf.slice(bounds.end);

  const lines = block.split('\n');
  const setKey = (key: 'model' | 'effort', value: string): void => {
    const idx = lines.findIndex((l) => new RegExp(`^${key}:\\s`).test(l) || l === `${key}:`);
    if (idx >= 0) lines[idx] = `${key}: ${value}`;
    else {
      // Insert after `name:` when present (it reads as the file's identity block),
      // else at the top of the frontmatter.
      const nameIdx = lines.findIndex((l) => /^name:\s/.test(l));
      lines.splice(nameIdx >= 0 ? nameIdx + 1 : 0, 0, `${key}: ${value}`);
    }
  };

  if (override.model !== undefined) setKey('model', override.model);
  if (override.effort !== undefined) setKey('effort', override.effort);

  return head + lines.join('\n') + tail;
}

/**
 * Read the `model` / `effort` a file's frontmatter currently declares.
 *
 * Used to answer "what does the PACKAGE ship?" when an override is cleared on a
 * customized agent — the only way `reset to default` can mean the shipped value
 * rather than whatever was injected last. Returns empty values on unparseable
 * frontmatter rather than throwing.
 */
export function readSpecialistFrontmatter(content: string): SleepSpecialistConfig {
  try {
    const data = matter(normalizeEol(content)).data as Record<string, unknown>;
    return {
      ...(typeof data.model === 'string' ? { model: data.model } : {}),
      ...(typeof data.effort === 'string' ? { effort: data.effort as SleepSpecialistConfig['effort'] } : {}),
    };
  } catch {
    return {};
  }
}
