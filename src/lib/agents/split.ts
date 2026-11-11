import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import matter from 'gray-matter';
import { PATTERN_HEADING, SOUL_HEADING, type AutomationManifest } from '../automations/types.js';
import {
  automationPath,
  createManifestText,
  extractSection,
  getRunTarget,
  listManifestFiles,
  pathOccupied,
  readManifestParts,
  rewriteManifestText,
} from '../automations/store.js';
import { manifestHash } from '../automations/registry.js';
import { shareAgent } from '../automations/sharing.js';
import { deriveAgentId } from './compose.js';
import { agentKeyOf, isSafeAutomationSlug, parseManifestFrontmatter, readManifestFrontmatter } from './slot.js';
import { agentPath, agentsDir, ensureAgentsGitignore } from './store.js';

/**
 * Splitting ONE legacy manifest (`automations/<slug>.md` with no `agent:` key)
 * into an agent file and, for a scheduled one, a job file bound to it.
 *
 * The approval carries over with NO registry write, by construction: the
 * composed hash after the split equals the legacy hash under the same slug, and
 * every machine checks that hash against its own records. The split checks this
 * itself and, when it does not hold, puts the legacy file back.
 *
 * Order (each step only after the one before it is durable):
 *  1. the agents `.gitignore` block (and the agent's negation when the manifest
 *     is shared) — BEFORE any agent file exists, so a private prompt is never
 *     committable, even for an instant;
 *  2. a machine-local backup of the legacy file
 *     (`~/.dreamcontext/backups/agents-split/<sha256(projectRoot)[0..16]>/<slug>.md`,
 *     dir 0700, file 0600);
 *  3. `agents/<slug>.md`, written deterministically (same bytes on every machine);
 *  4. the automation file: a scheduled manifest loses its identity keys and its
 *     `## Prompt` / `## Pattern` and gains `agent: <slug>`; an on-call manifest is
 *     removed (it IS the agent);
 *  5. the self-check.
 *
 * Only an I/O failure is a `failedCount`-worthy outcome (`io-error`: it can
 * succeed on a retry). A hash mismatch and a conflict are deterministic: the
 * legacy file stays (or is put back) and keeps working through the on-read path.
 */

export type SplitOutcome = 'split' | 'already-split' | 'mismatch' | 'conflict' | 'io-error';

export interface SplitResult {
  outcome: SplitOutcome;
  /** Files written or removed, contextRoot-relative. */
  files: string[];
  reason?: string;
}

export interface SplitOptions {
  /** HOME for the backup folder (tests inject a scratch one). */
  home?: string;
  /** TEST SEAM: simulate the process dying right after the named step. Also read
   *  from `DREAMCONTEXT_SPLIT_FAIL_AFTER`, for the runtime verify script. */
  failAfter?: 'agent' | 'automation';
}

/** Thrown by the test seam only: a simulated crash, never caught here. */
export class SplitInterruptedError extends Error {
  constructor(step: string) {
    super(`split interrupted after the ${step} step (test seam)`);
    this.name = 'SplitInterruptedError';
  }
}

const IO_CODES: ReadonlySet<string> = new Set([
  'EACCES', 'EPERM', 'ENOSPC', 'EBUSY', 'EROFS', 'EIO', 'EMFILE', 'ENFILE', 'EAGAIN', 'EXDEV', 'EDQUOT',
]);

function isIoError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return typeof code === 'string' && IO_CODES.has(code);
}

/** Identity keys a split automation file no longer carries: they are the agent's. */
const IDENTITY_KEYS: ReadonlySet<string> = new Set(['photo', 'model', 'effort', 'learning', 'whiteboard']);

/** The marker an agent file carries to say which legacy manifest it came from.
 *  A manifest with no id gets a slug-derived one, so a foreign agent file with
 *  no marker can never be mistaken for ours. */
function legacyMarker(m: AutomationManifest): string {
  return m.id || `legacy:${m.slug}`;
}

/** The agent file a legacy manifest splits into — deterministic bytes. */
function agentFileText(m: AutomationManifest, content: string): string {
  const isCall = m.mode === 'call';
  const frontmatter: Record<string, unknown> = {
    id: deriveAgentId(m.id, m.slug),
    title: m.title,
    ...(m.photo ? { photo: m.photo } : {}),
    ...(m.model ? { model: m.model } : {}),
    ...(m.effort ? { effort: m.effort } : {}),
    ...(m.learning ? { learning: true } : {}),
    ...(m.whiteboard ? { whiteboard: m.whiteboard } : {}),
    shared: m.shared,
    ...(isCall
      ? {
          call: {
            timeout_minutes: m.timeoutMinutes,
            output_dir: m.outputDir,
            review: m.review,
            enabled: m.enabled,
            notify: m.notify,
            ...(m.appTools?.length ? { app_tools: [...m.appTools] } : {}),
          },
        }
      : {}),
    migrated_from: legacyMarker(m),
  };
  const body: string[] = ['## Prompt', '', m.prompt, ''];
  if (m.soul) body.push(`## ${SOUL_HEADING}`, '', m.soul, '');
  if (isCall) {
    if (m.outputInstructions) body.push('## Output instructions', '', m.outputInstructions, '');
    // The raw section, fence and all, so it parses back to the same graph.
    if (m.flow !== null) body.push('## Flow', '', extractSection(content, 'Flow'), '');
  }
  if (m.pattern) body.push(`## ${PATTERN_HEADING}`, '', m.pattern, '');
  return matter.stringify(body.join('\n'), frontmatter);
}

/** Remove `## <heading>` sections (heading line through the line before the next
 *  `## `), leaving every other byte where it was. */
function removeSections(content: string, headings: readonly string[]): string {
  const targets = new Set(headings.map((h) => `## ${h}`));
  const out: string[] = [];
  let skipping = false;
  for (const line of content.split('\n')) {
    if (/^##\s/.test(line)) skipping = targets.has(line.trim());
    if (!skipping) out.push(line);
  }
  const text = out.join('\n').replace(/^\s+/, '');
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** The split automation file of a scheduled legacy manifest. */
function jobFileText(slug: string, data: Record<string, unknown>, content: string): string {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (IDENTITY_KEYS.has(key)) continue;
    next[key] = value;
    if (key === 'title') next.agent = slug;
  }
  if (!('agent' in next)) next.agent = slug;
  return matter.stringify(removeSections(content, ['Prompt', SOUL_HEADING, PATTERN_HEADING]), next);
}

function backupDir(projectRoot: string, home?: string): string {
  const key = createHash('sha256').update(projectRoot, 'utf8').digest('hex').slice(0, 16);
  return join(home ?? homedir(), '.dreamcontext', 'backups', 'agents-split', key);
}

/** Write the machine-local backup (dir 0700, file 0600), never through a symlink. */
function writeBackup(projectRoot: string, slug: string, text: string, home?: string): string {
  const dir = backupDir(projectRoot, home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = join(dir, `${slug}.md`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { encoding: 'utf-8', mode: 0o600 });
  renameSync(tmp, file);
  chmodSync(file, 0o600);
  return file;
}

function seam(opts: SplitOptions): string | undefined {
  return opts.failAfter ?? process.env.DREAMCONTEXT_SPLIT_FAIL_AFTER;
}

/** Put the legacy file back exactly and remove the new agent file. Best effort:
 *  each half is attempted even if the other fails. */
function restore(contextRoot: string, slug: string, legacyText: string): void {
  const path = automationPath(contextRoot, slug);
  try {
    if (pathOccupied(path)) rewriteManifestText(path, legacyText);
    else createManifestText(path, legacyText);
  } catch {
    // the backup under ~/.dreamcontext still holds it; doctor names the slug
  }
  try {
    const agentFile = agentPath(contextRoot, slug);
    if (pathOccupied(agentFile) && lstatSync(agentFile).isFile()) unlinkSync(agentFile);
  } catch {
    // an agent file left behind is shadowed by the restored legacy file on read
  }
}

interface LegacyRead {
  legacyText: string;
  data: Record<string, unknown>;
  content: string;
  legacy: AutomationManifest;
}

/** Read the slot's file as a legacy manifest, or the outcome that ends the split. */
function readLegacy(path: string, rel: string): LegacyRead | { result: SplitResult } {
  try {
    const legacyText = readFileSync(path, 'utf-8');
    const { data, content } = parseManifestFrontmatter(legacyText);
    const parts = readManifestParts(path);
    if (parts.kind === 'bound') return { result: { outcome: 'already-split', files: [] } };
    return { legacyText, data, content, legacy: parts.legacy };
  } catch (err) {
    return {
      result: isIoError(err)
        ? { outcome: 'io-error', files: [], reason: (err as Error).message }
        : { outcome: 'conflict', files: [], reason: `${rel} does not parse` },
    };
  }
}

/**
 * Split one legacy manifest. Idempotent: a slot already holding a split file (or
 * nothing, after an on-call split) is `already-split`; an agent file this split
 * wrote earlier (its `migrated_from` names this manifest) is overwritten from
 * the legacy file, which stays the source of truth until it is rewritten.
 */
export function splitLegacyManifest(contextRoot: string, slug: string, opts: SplitOptions = {}): SplitResult {
  if (!isSafeAutomationSlug(slug)) return { outcome: 'conflict', files: [], reason: 'not a valid slug' };
  const path = automationPath(contextRoot, slug);
  const rel = `automations/${slug}.md`;
  const agentRel = `agents/${slug}.md`;
  if (!pathOccupied(path)) return { outcome: 'already-split', files: [] };
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) return { outcome: 'conflict', files: [], reason: `${rel} is not a regular file` };

  const read = readLegacy(path, rel);
  if ('result' in read) return read.result;
  const { legacyText, data, content, legacy } = read;

  const agentFile = agentPath(contextRoot, slug);
  if (pathOccupied(agentFile)) {
    const existing = readManifestFrontmatter(agentFile);
    if (existing === null || existing.data.migrated_from !== legacyMarker(legacy)) {
      return { outcome: 'conflict', files: [], reason: `${agentRel} exists and did not come from ${rel}` };
    }
  }

  const legacyHash = manifestHash(legacy);
  const isCall = legacy.mode === 'call';
  try {
    ensureAgentsGitignore(contextRoot);
    if (legacy.shared) shareAgent(contextRoot, slug);
    writeBackup(dirname(contextRoot), slug, legacyText, opts.home);
  } catch (err) {
    return { outcome: 'io-error', files: [], reason: (err as Error).message };
  }

  try {
    mkdirSync(agentsDir(contextRoot), { recursive: true });
    const text = agentFileText(legacy, content);
    if (pathOccupied(agentFile)) rewriteManifestText(agentFile, text);
    else createManifestText(agentFile, text);
    if (seam(opts) === 'agent') throw new SplitInterruptedError('agent');

    if (isCall) {
      unlinkSync(path);
    } else {
      rewriteManifestText(path, jobFileText(slug, data, content));
    }
    if (seam(opts) === 'automation') throw new SplitInterruptedError('automation');
  } catch (err) {
    if (err instanceof SplitInterruptedError) throw err;
    restore(contextRoot, slug, legacyText);
    return isIoError(err)
      ? { outcome: 'io-error', files: [], reason: (err as Error).message }
      : { outcome: 'conflict', files: [], reason: (err as Error).message };
  }

  const after = getRunTarget(contextRoot, slug, isCall ? 'agent' : 'automation');
  if (!after || manifestHash(after) !== legacyHash) {
    restore(contextRoot, slug, legacyText);
    return { outcome: 'mismatch', files: [], reason: `${rel} would not hash the same after the split` };
  }
  return { outcome: 'split', files: [agentRel, rel] };
}

export interface SplitAllResult {
  results: { slug: string; outcome: SplitOutcome; reason?: string }[];
  /** How many ended `io-error` — the only outcome a migration counts as failed. */
  failed: number;
}

/** Split every legacy manifest in the vault. A symlinked or unparseable manifest
 *  is reported as a conflict and left alone. Never writes the approval registry. */
export function splitAllLegacy(contextRoot: string, opts: SplitOptions = {}): SplitAllResult {
  const results: SplitAllResult['results'] = [];
  for (const file of listManifestFiles(contextRoot)) {
    const slug = basename(file, '.md');
    const fm = readManifestFrontmatter(file);
    if (fm === null) {
      results.push({ slug, outcome: 'conflict', reason: `automations/${slug}.md is a symlink or does not parse` });
      continue;
    }
    if (agentKeyOf(fm.data).kind !== 'none') continue;
    const r = splitLegacyManifest(contextRoot, slug, opts);
    results.push({ slug, outcome: r.outcome, ...(r.reason ? { reason: r.reason } : {}) });
  }
  return { results, failed: results.filter((r) => r.outcome === 'io-error').length };
}
