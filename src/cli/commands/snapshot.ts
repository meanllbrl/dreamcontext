import { Command } from 'commander';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import fg from 'fast-glob';
import { resolveContextRoot } from '../../lib/context-path.js';
import { resolveVaultContextRoot, VaultError } from '../../lib/vaults.js';
import { error } from '../../lib/format.js';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { readJsonArray } from '../../lib/json-file.js';
import { readSection } from '../../lib/markdown.js';
import { readSleepState, writeSleepState, readSleepHistory } from './sleep.js';
import { buildKnowledgeIndex } from '../../lib/knowledge-index.js';
import { buildCoreIndex } from '../../lib/core-index.js';
import { buildMarketingSnapshot } from '../../lib/marketing/snapshot.js';
import { readSetupConfig, isMultiPerson } from '../../lib/setup-config.js';
import { isSkillInstalled } from '../../lib/catalog.js';
import { readVersionCache, isCacheFresh, buildNudge, readAutoUpgradeMarker, shouldSuppressCliNudge } from '../../lib/version-check.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { buildDriftDirective, resolveDriftState } from '../../lib/setup-drift.js';
import { readAssetDriftCache, cacheConfidentlyClean } from '../../lib/asset-drift-cache.js';
import { computeFeatureFreshness, freshnessSnapshotNote } from '../../lib/feature-freshness.js';
import { pendingInboxCount } from '../../lib/federation-inbox.js';
import { readPeerSummaryCache } from '../../lib/federation-peer-summary.js';
import {
  applyBudget, resolveBudget, demoteMemoryBlock, demoteTaskList,
  type BudgetSection,
} from '../../lib/snapshot-budget.js';

/**
 * Default line cap when inlining pinned knowledge into the auto-context snapshot.
 * Per-entry overrides via frontmatter `pinned_preview_lines: N` or `pinned_preview: "all"`.
 */
export const DEFAULT_PINNED_PREVIEW_LINES = 60;

/**
 * Strip leading YAML frontmatter and surrounding blank lines from markdown content.
 * Used by the preview helpers below.
 */
function stripFrontmatter(content: string): string {
  const lines = content.split('\n');
  let i = 0;
  if (lines[0]?.trim() === '---') {
    i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    if (i < lines.length) i++;
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  return lines.slice(i).join('\n');
}

/**
 * Take up to `maxLines` lines of body content (after frontmatter).
 * Returns `truncated: true` if the original body was longer than `maxLines`.
 * Preserves markdown structure — no paragraph joining, no char cap.
 */
export function extractPinnedPreview(
  content: string,
  maxLines: number,
): { preview: string; truncated: boolean; totalLines: number } {
  const body = stripFrontmatter(content).replace(/\s+$/, '');
  const lines = body.split('\n');
  const totalLines = lines.length;
  if (totalLines <= maxLines) {
    return { preview: body, truncated: false, totalLines };
  }
  return { preview: lines.slice(0, maxLines).join('\n'), truncated: true, totalLines };
}

/**
 * Extract the first paragraph from markdown content.
 * Skips headings, blank lines, and frontmatter blocks.
 * Returns the first block of contiguous body text.
 */
export function extractFirstParagraph(content: string): string {
  const lines = content.split('\n');
  const paragraphLines: string[] = [];
  let started = false;
  let inFrontmatter = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Handle YAML frontmatter blocks (--- ... ---)
    if (trimmed === '---') {
      if (!started) {
        inFrontmatter = !inFrontmatter;
        continue;
      }
    }
    if (inFrontmatter) continue;

    if (!started) {
      // Skip headings and blank lines
      if (!trimmed || trimmed.startsWith('#')) continue;
      started = true;
    }
    if (started) {
      if (!trimmed) break; // end of first paragraph
      if (trimmed.startsWith('#')) break; // next heading
      paragraphLines.push(trimmed);
    }
  }

  const result = paragraphLines.join(' ');
  return result.length > 300 ? result.slice(0, 297) + '...' : result;
}

/**
 * Build formatted lines for active (non-completed) tasks in state/*.md.
 * Shared by generateSnapshot() and generateSubagentBriefing().
 */
interface ActiveTaskEntry {
  text: string;
  status: string;
  priority: string;
  updated: string;
}

/**
 * Sort for DEMOTED task rendering only (the full render keeps file order so
 * under-budget snapshots stay byte-identical): in_progress first, then
 * priority, then most recently updated.
 */
export function sortTaskEntriesByActivity(entries: ActiveTaskEntry[]): ActiveTaskEntry[] {
  const statusRank = (s: string): number => (s === 'in_progress' ? 0 : s === 'blocked' ? 1 : 2);
  const prioRank = (p: string): number =>
    p === 'critical' ? 0 : p === 'high' ? 1 : p === 'medium' ? 2 : 3;
  return [...entries].sort((a, b) =>
    statusRank(a.status) - statusRank(b.status)
    || prioRank(a.priority) - prioRank(b.priority)
    || b.updated.localeCompare(a.updated));
}

function getActiveTaskEntries(root: string): ActiveTaskEntry[] {
  const stateDir = join(root, 'state');
  if (!existsSync(stateDir)) return [];

  const taskFiles = fg.sync('*.md', { cwd: stateDir, absolute: true });
  const entries: ActiveTaskEntry[] = [];

  for (const file of taskFiles) {
    try {
      const { data } = readFrontmatter(file);
      const status = String(data.status ?? 'unknown');
      if (status === 'completed') continue;
      const name = basename(file, '.md');
      const priority = String(data.priority ?? '-');
      const updated = String(data.updated_at ?? data.created_at ?? '');

      let line = `- ${name} (status: ${status}, priority: ${priority}, updated: ${updated})`;

      // Why (from ## Why section, first real line)
      // Strip HTML comments first (template placeholders like
      // `<!-- What problem does this solve? ... -->` would otherwise leak in).
      try {
        const whyContent = readSection(file, 'Why');
        if (whyContent) {
          const stripped = whyContent.replace(/<!--[\s\S]*?-->/g, '');
          const firstLine = stripped.split('\n').find(l => l.trim() && !l.trim().startsWith('('))?.trim();
          if (firstLine) {
            const capped = firstLine.length > 250 ? firstLine.slice(0, 247) + '...' : firstLine;
            line += `\n  Why: ${capped}`;
          }
        }
      } catch { /* skip */ }

      entries.push({ text: line, status, priority, updated });
    } catch {
      // skip unreadable files
    }
  }

  return entries;
}

/**
 * Resolve the "active task" for the current session.
 *
 * Heuristic, in order of preference:
 *   1. `_dream_context/state/.active-task` file (plain text containing the task slug),
 *      if present. Lets the user/CLI override the heuristic explicitly.
 *   2. Otherwise, scan `_dream_context/state/*.md` for tasks with status `in_progress`
 *      and pick the most recently modified one (mtime fallback to frontmatter
 *      `updated_at` if mtime is unreliable).
 *
 * Returns the absolute task file path, or null if none matches.
 *
 * Edge cases / fragility:
 * - Multiple in_progress tasks across products: we pick the most recent.
 *   If the user switched products mid-session, the snapshot will reflect the
 *   last-edited task, not the one they're about to resume. Workaround: write
 *   the slug to `.active-task`.
 * - All tasks `todo`/`in_review`: no active task -> no product knowledge injected.
 * - Frontmatter without `product:`: no injection (single-product fallback).
 */
function resolveActiveTaskPath(root: string): string | null {
  const stateDir = join(root, 'state');
  if (!existsSync(stateDir)) return null;

  // 1. Explicit override
  const overridePath = join(stateDir, '.active-task');
  if (existsSync(overridePath)) {
    try {
      const slug = readFileSync(overridePath, 'utf-8').trim();
      if (slug) {
        const taskPath = join(stateDir, `${slug}.md`);
        if (existsSync(taskPath)) return taskPath;
      }
    } catch { /* fall through to heuristic */ }
  }

  // 2. Heuristic: most recently modified in_progress task
  const taskFiles = fg.sync('*.md', { cwd: stateDir, absolute: true });
  type Candidate = { path: string; mtime: number };
  const candidates: Candidate[] = [];

  for (const file of taskFiles) {
    try {
      const { data } = readFrontmatter(file);
      const status = String(data.status ?? '');
      if (status !== 'in_progress') continue;
      let mtime = 0;
      try {
        mtime = statSync(file).mtimeMs;
      } catch { /* skip */ }
      candidates.push({ path: file, mtime });
    } catch {
      // skip unreadable
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0].path;
}

/**
 * Build the "Active Product Knowledge" section if the active task is bound to
 * a configured product. Returns an empty array when not applicable.
 *
 * Trigger:
 *   - `_dream_context/state/.config.json` has `multiProduct: string[]`
 *   - resolveActiveTaskPath() returns a task whose frontmatter `product: X`
 *     is one of the configured products
 *   - `_dream_context/knowledge/products/<X>.md` exists
 *
 * Cap the injected content at ~200 lines to avoid blowing up the snapshot;
 * direct the agent to read the full file if truncated.
 */
function getActiveProductKnowledge(root: string): string[] {
  // root = _dream_context/ dir; readSetupConfig expects project root
  const config = readSetupConfig(dirname(root));
  if (!config || !Array.isArray(config.multiProduct) || config.multiProduct.length === 0) {
    return [];
  }

  const activeTaskPath = resolveActiveTaskPath(root);
  if (!activeTaskPath) return [];

  let product = '';
  try {
    const { data } = readFrontmatter(activeTaskPath);
    if (typeof data.product === 'string' && data.product.trim()) {
      product = data.product.trim();
    }
  } catch {
    return [];
  }

  if (!product) return [];
  if (!config.multiProduct.includes(product)) return [];

  const productKnowledgePath = join(root, 'knowledge', 'products', `${product}.md`);
  if (!existsSync(productKnowledgePath)) return [];

  let raw: string;
  try {
    raw = readFileSync(productKnowledgePath, 'utf-8');
  } catch {
    return [];
  }

  // Strip frontmatter for the snapshot body
  const body = (() => {
    const lines = raw.split('\n');
    if (lines[0]?.trim() !== '---') return raw;
    let i = 1;
    while (i < lines.length && lines[i].trim() !== '---') i++;
    if (i < lines.length) i++;
    return lines.slice(i).join('\n').replace(/^\s+/, '');
  })();

  const MAX_LINES = 200;
  const bodyLines = body.split('\n');
  let injected: string;
  let truncatedNote = '';
  if (bodyLines.length > MAX_LINES) {
    injected = bodyLines.slice(0, MAX_LINES).join('\n');
    truncatedNote = `\n→ Truncated; read full: _dream_context/knowledge/products/${product}.md (${bodyLines.length} lines total)`;
  } else {
    injected = body;
  }

  return [
    `## Active Product Knowledge: ${product}\n`,
    `_Auto-injected because the active task has \`product: ${product}\` and \`_dream_context/state/.config.json\` lists ${product} under \`multiProduct\`._\n`,
    injected.trim(),
    truncatedNote ? truncatedNote.trim() : '',
    '',
  ].filter((s) => s !== '');
}

/**
 * Read-only version nudge for the snapshot.
 * Uses only the on-disk cache — NO network, NO subprocess, NO catalog load.
 * Returns '' when the cache is absent/stale or when there is nothing to report.
 * Never throws.
 *
 * NOTE: `root` here is the `_dream_context/` directory path (as returned by
 * resolveContextRoot). readVersionCache and readSetupConfig both expect a
 * project root (parent of _dream_context/), so we derive it via dirname(root).
 */
function getVersionNudge(root: string): string {
  try {
    // root = /path/to/project/_dream_context
    // projectRoot = /path/to/project
    const projectRoot = dirname(root);
    const cache = readVersionCache(projectRoot);
    if (!cache || !isCacheFresh(cache)) return '';

    const installedCli = dreamcontextVersion();
    // availablePacks was stored by refreshVersionCache. Filter by filesystem truth
    // (the pack's SKILL.md on disk) — NOT config.packs, which drifts and produces
    // false "new pack available" nudges for packs that are already installed.
    // isSkillInstalled only stats a path; it does not load/parse the catalog.
    const catalogPackNames = cache.availablePacks;
    const installedPacks = catalogPackNames.filter((name) => isSkillInstalled(projectRoot, name));

    // Auto-upgrade is on by default. Suppress the redundant "run dreamcontext
    // upgrade" line only while a background upgrade for this exact version is
    // freshly in flight; if it failed (still behind after the window) the nudge
    // returns so the user can act. New-packs line is unaffected.
    const marker = readAutoUpgradeMarker(projectRoot);
    const suppressCliNudge = shouldSuppressCliNudge(cache.latestCli, marker, process.env);
    const nudge = buildNudge(installedCli, cache, installedPacks, catalogPackNames, { suppressCliNudge });
    return nudge ?? '';
  } catch {
    return '';
  }
}

/**
 * Read-only migration note for the snapshot.
 * Reads .sleep.json pendingMigrationNotices and returns a note if non-empty.
 * NEVER writes the ledger or .sleep.json — snapshot is strictly read-only.
 * Returns '' when there are no pending notices or on any error.
 * Never throws.
 */
function getMigrationNote(root: string): string {
  try {
    const sleepPath = join(root, 'state', '.sleep.json');
    if (!existsSync(sleepPath)) return '';
    const raw = readFileSync(sleepPath, 'utf-8');
    const parsed = JSON.parse(raw) as { pendingMigrationNotices?: unknown };
    if (
      !parsed ||
      !Array.isArray(parsed.pendingMigrationNotices) ||
      parsed.pendingMigrationNotices.length === 0
    ) {
      return '';
    }
    // Notices derive from migration summaries built from filenames — strip
    // newlines + markdown-structural chars and cap length so a crafted filename
    // can't inject a heading/directive into the agent snapshot; dedupe repeats.
    const seen = new Set<string>();
    const notices = (parsed.pendingMigrationNotices as unknown[])
      .filter((n): n is string => typeof n === 'string')
      .map((n) =>
        n.replace(/[\r\n]+/g, ' ').replace(/[#`*>[\]]/g, '').slice(0, 200).trim(),
      )
      .filter((n) => n.length > 0 && !seen.has(n) && (seen.add(n), true));
    if (notices.length === 0) return '';
    return `## Migrations Applied\nMigrations applied since last session: ${notices.join('; ')}`;
  } catch {
    return '';
  }
}

/**
 * Read-only drift directive for the snapshot.
 * Mirrors getVersionNudge — pure read, no I/O side effects, no subprocess.
 * Returns '' when drift check is disabled, config is absent, or no directive applies.
 * Never throws.
 *
 * NOTE: `root` here is the `_dream_context/` directory path (as returned by
 * resolveContextRoot). readSetupConfig expects a project root (parent of
 * _dream_context/), so we derive it via dirname(root).
 */
function getDriftDirective(root: string): string {
  try {
    const projectRoot = dirname(root);
    const config = readSetupConfig(projectRoot);
    if (!config) return '';
    const cliVersion = dreamcontextVersion();
    const driftInput = {
      cliVersion,
      setupVersion: config.setupVersion,
      driftCheckEnv: process.env.DREAMCONTEXT_DRIFT_CHECK,
    };
    // Scope the nag: when version drift flags staleness, suppress it ONLY if a
    // fresh content check (computed out-of-band by the detached refresher, see
    // asset-drift.ts) confidently proved that no asset THIS project uses would
    // change on update — i.e. the bump only touched packs it doesn't install.
    // Anything less certain (no cache yet, version-mismatched cache, or a real
    // change) falls open to the nag: better an extra nudge than a missed update.
    const state = resolveDriftState(driftInput);
    if (state === 'stale' || state === 'bootstrap') {
      const cache = readAssetDriftCache(root);
      if (cacheConfidentlyClean(cache, cliVersion, config.setupVersion)) return '';
    }
    return buildDriftDirective(driftInput) ?? '';
  } catch {
    return '';
  }
}

/**
 * Output a plain-text context snapshot to stdout.
 * Designed for SessionStart hook consumption — no chalk, no interactivity.
 * If _dream_context/ doesn't exist, exits silently.
 *
 * `rootOverride` (federation P1.4) prints a PEER vault's snapshot from an
 * already-resolved context root; the no-arg path resolves the local context root
 * exactly as before and is BYTE-IDENTICAL to the pre-federation behaviour (the
 * SessionStart hook calls it with no argument — regression-guarded). No peer
 * resolution, no cross-vault work happens on the no-arg path.
 */
export function generateSnapshot(rootOverride?: string): string {
  const root = rootOverride ?? resolveContextRoot();
  if (!root) return '';

  // Snapshot is assembled as budget SECTIONS (see src/lib/snapshot-budget.ts):
  // blocks accumulate into `parts`, then flush() seals them into a named
  // section. Demotable sections carry pre-rendered ladder rungs; identity and
  // warning sections are neverEvict. Under budget, the output is byte-identical
  // to the pre-budget format (sections join exactly like the old parts array).
  const sections: BudgetSection[] = [];
  let parts: string[] = ['# Agent Context — Auto-loaded\n'];
  const flush = (id: string, opts: { neverEvict?: boolean; demotions?: string[] } = {}): void => {
    if (parts.length > 0) {
      sections.push({ id, text: parts.join('\n'), ...opts });
      parts = [];
    }
  };

  // 1. Soul file (full content) — WHO the agent is
  const soulPath = join(root, 'core', '0.soul.md');
  if (existsSync(soulPath)) {
    const content = readFileSync(soulPath, 'utf-8').trim();
    parts.push('## Soul (Agent Identity, Principles, Rules)\n');
    parts.push(content);
    parts.push('');
  }

  // 2. User file (full content) — WHO uses the agent
  const userPath = join(root, 'core', '1.user.md');
  if (existsSync(userPath)) {
    const content = readFileSync(userPath, 'utf-8').trim();
    parts.push('## User (Preferences, Project Details, Rules)\n');
    parts.push(content);
    parts.push('');
  }
  flush('identity', { neverEvict: true });

  // 3. Memory file (full content) — WHAT the agent knows.
  // Demotion: Technical Decisions keeps the newest N bullets, older collapse
  // to titles (still recallable); Active Memory + Known Issues never shrink.
  const memoryPath = join(root, 'core', '2.memory.md');
  if (existsSync(memoryPath)) {
    const content = readFileSync(memoryPath, 'utf-8').trim();
    if (content) {
      parts.push('## Memory (Technical Decisions, Known Issues, Session Log)\n');
      parts.push(content);
      parts.push('');
      const full = parts.join('\n');
      flush('memory', { demotions: [demoteMemoryBlock(full, 8), demoteMemoryBlock(full, 4)] });
    }
  }

  // 4. Extended Core Files index (files 3+, not loaded in full)
  const coreExtras = buildCoreIndex(root);
  if (coreExtras.length > 0) {
    parts.push('## Extended Core Files\n');
    for (const entry of coreExtras) {
      let line = `- **${entry.name}** (${entry.path})`;
      if (entry.summary) {
        line += `: ${entry.summary}`;
      }
      parts.push(line);
    }
    parts.push('');
  }
  flush('extended-core', { neverEvict: true });

  // 5. Active tasks. Full render keeps file order (byte-identical under
  // budget); demoted renders sort by activity and cap the list, the remainder
  // collapsing to a count line — every task is still one `tasks list` away.
  const activeTasks = getActiveTaskEntries(root);
  if (activeTasks.length > 0) {
    parts.push('## Active Tasks\n');
    parts.push(activeTasks.map((t) => t.text).join('\n'));
    parts.push('');
    const sortedTexts = sortTaskEntriesByActivity(activeTasks).map((t) => t.text);
    const renderTasks = (keep: number): string =>
      ['## Active Tasks\n', demoteTaskList(sortedTexts, keep).join('\n'), ''].join('\n');
    flush('tasks', { demotions: [renderTasks(12), renderTasks(8)] });
  }

  // 5.1 Active Product Knowledge (multi-product binding)
  // If the active in_progress task has `product: X` frontmatter AND
  // state/.config.json lists X under multiProduct, inject
  // knowledge/products/X.md into the snapshot so the agent never has to
  // remember to load it manually.
  const productKnowledge = getActiveProductKnowledge(root);
  if (productKnowledge.length > 0) {
    parts.push(...productKnowledge);
  }

  // 5.2 Version nudge (read-only — no network, uses cached data only)
  const versionNudge = getVersionNudge(root);
  if (versionNudge) {
    parts.push(versionNudge);
    parts.push('');
  }

  // 5.3 Setup version drift directive (read-only — compares setupVersion vs CLI)
  const driftDirective = getDriftDirective(root);
  if (driftDirective) {
    parts.push(driftDirective);
    parts.push('');
  }

  // 5.4 Migration note (read-only — reads .sleep.json pendingMigrationNotices,
  //     never writes; cleared by sleep start after surfacing once per cycle).
  const migrationNote = getMigrationNote(root);
  if (migrationNote) {
    parts.push(migrationNote);
    parts.push('');
  }
  flush('product-and-nudge', { neverEvict: true });

  // 5.5 Read sleep state (used by multiple sections below)
  const sleepState = readSleepState(root);

  // 5.6 Bookmarks (awake ripples, tagged moments from previous sessions)
  if (sleepState.bookmarks.length > 0) {
    const sorted = [...sleepState.bookmarks].sort((a, b) => b.salience - a.salience);
    parts.push('## Bookmarks\n');
    const salienceLabels: Record<number, string> = { 1: '*', 2: '**', 3: '***' };
    for (const b of sorted) {
      const taskRef = b.task_slug ? ` (task: ${b.task_slug})` : '';
      parts.push(`- ${salienceLabels[b.salience] || '*'} ${b.message}${taskRef}`);
    }
    parts.push('');
  }

  // 5.7 Contextual Reminders (matching triggers for active tasks)
  if (sleepState.triggers.length > 0) {
    // Gather active task names and tags for matching
    const taskNames: string[] = [];
    const taskTags: string[] = [];
    const stateDir = join(root, 'state');
    if (existsSync(stateDir)) {
      const taskFiles = fg.sync('*.md', { cwd: stateDir, absolute: true });
      for (const file of taskFiles) {
        try {
          const { data } = readFrontmatter(file);
          if (String(data.status ?? '') === 'completed') continue;
          taskNames.push(basename(file, '.md').toLowerCase());
          if (Array.isArray(data.tags)) {
            taskTags.push(...data.tags.map((t: string) => String(t).toLowerCase()));
          }
        } catch { /* skip */ }
      }
    }
    // Also check recent bookmark messages
    const recentBookmarkText = sleepState.bookmarks.map(b => b.message.toLowerCase()).join(' ');

    const matchContext = [...taskNames, ...taskTags].join(' ') + ' ' + recentBookmarkText;

    const matchedTriggers = sleepState.triggers.filter(t => {
      if (t.fired_count >= t.max_fires) return false;
      const keywords = t.when.toLowerCase().split(/[\s,]+/);
      return keywords.some(kw => matchContext.includes(kw));
    });

    if (matchedTriggers.length > 0) {
      parts.push('## Contextual Reminders\n');
      for (const t of matchedTriggers) {
        parts.push(`- ${t.remind}`);
        // Increment fired_count
        t.fired_count++;
      }
      parts.push('');
      // Persist trigger fired_count updates
      writeSleepState(root, sleepState);
    }
  }
  flush('awareness', { neverEvict: true });

  // 6. Sleep State — DEPRECATED in snapshot (v0.4.0+).
  // Sleep debt + critical bookmark reminders are delivered by the
  // UserPromptSubmit hook on every prompt; rendering them here too would
  // duplicate the signal and bloat the snapshot. Kept as a no-op block for
  // clarity; remove entirely in a later cleanup if the hook stays stable.

  // 7. Recent changelog — tiered display (2026-05-23):
  //   Tier 1 (top 3): summary headline + first ~300 chars of description.
  //   Tier 2 (next 10): one-line headline only (summary or truncated desc).
  //   Rationale: recent events deserve narrative; older events stay on the
  //   horizon as titles so the agent knows what shipped without paying full
  //   description token cost. Full text always recoverable via
  //   `dreamcontext memory recall --types changelog`.
  const CHANGELOG_TIER1 = 3;
  const CHANGELOG_TIER2 = 10;
  const TIER1_BODY_CHARS = 300;
  const TIER2_LINE_CHARS = 140;
  // Person attribution is gated on DERIVED multi-person status. Single-person
  // projects (no roster / roster ≤1) never render `— by …`, so their Recent
  // Changelog output stays byte-identical to today.
  const multiPerson = isMultiPerson(readSetupConfig(dirname(root)));
  const authorSuffix = (e: Record<string, unknown>): string => {
    if (!multiPerson) return '';
    const authors = Array.isArray(e.authors)
      ? e.authors.filter((a): a is string => typeof a === 'string')
      : [];
    return authors.length > 0 ? ` — by ${authors.join(', ')}` : '';
  };
  const changelogPath = join(root, 'core', 'CHANGELOG.json');
  if (existsSync(changelogPath)) {
    try {
      const entries = readJsonArray<Record<string, unknown>>(changelogPath);
      const tier1 = entries.slice(0, CHANGELOG_TIER1);
      const tier2 = entries.slice(CHANGELOG_TIER1, CHANGELOG_TIER1 + CHANGELOG_TIER2);
      const headlineOf = (e: Record<string, unknown>): string => {
        const date = String(e.date ?? '');
        const type = String(e.type ?? '');
        const scope = String(e.scope ?? '');
        const summary = typeof e.summary === 'string' ? e.summary : '';
        const desc = String(e.description ?? '');
        const headline = summary || (desc.length > 200 ? desc.slice(0, 197) + '...' : desc);
        return `- ${date} [${type}] ${scope}: ${headline}${authorSuffix(e)}`;
      };
      const tier2LineOf = (e: Record<string, unknown>): string => {
        const date = String(e.date ?? '');
        const type = String(e.type ?? '');
        const scope = String(e.scope ?? '');
        const summary = typeof e.summary === 'string' ? e.summary : '';
        const desc = String(e.description ?? '');
        const raw = summary || desc;
        const line = raw.length > TIER2_LINE_CHARS
          ? raw.slice(0, TIER2_LINE_CHARS - 3) + '...'
          : raw;
        return `- ${date} [${type}] ${scope}: ${line}${authorSuffix(e)}`;
      };
      const renderChangelog = (withBodies: boolean, tier2Count: number): string[] => {
        const out: string[] = ['## Recent Changelog\n'];
        for (const e of tier1) {
          out.push(headlineOf(e));
          const summary = typeof e.summary === 'string' ? e.summary : '';
          const desc = String(e.description ?? '');
          // Body preview only when summary is present (otherwise headline is
          // already the description). Avoids printing the same text twice.
          if (withBodies && summary && desc && desc !== summary) {
            const body = desc.length > TIER1_BODY_CHARS
              ? desc.slice(0, TIER1_BODY_CHARS - 3) + '...'
              : desc;
            out.push(`    ${body}`);
          }
        }
        const t2 = tier2.slice(0, tier2Count);
        if (t2.length > 0) {
          out.push('');
          out.push('### Older (titles only — use `dreamcontext memory recall --types changelog` for detail):');
          for (const e of t2) out.push(tier2LineOf(e));
        }
        out.push('');
        return out;
      };
      if (tier1.length > 0) {
        parts.push(...renderChangelog(true, CHANGELOG_TIER2));
        flush('changelog', {
          demotions: [
            renderChangelog(false, 5).join('\n'),
            renderChangelog(false, 0).join('\n'),
          ],
        });
      }
    } catch {
      // skip if malformed
    }
  }

  // 7.5. Releases (planning + latest released)
  const releasesPath = join(root, 'core', 'RELEASES.json');
  if (existsSync(releasesPath)) {
    try {
      const releases = readJsonArray<Record<string, unknown>>(releasesPath);
      if (releases.length > 0) {
        const planning = releases.filter(r => r.status === 'planning');
        const released = releases.filter(r => r.status !== 'planning');

        if (planning.length > 0) {
          parts.push('## Upcoming Versions\n');
          for (const p of planning) {
            const ver = String(p.version ?? '');
            const sum = String(p.summary ?? '');
            const taskCount = Array.isArray(p.tasks) ? p.tasks.length : 0;
            parts.push(`- ${ver}: ${sum}${taskCount > 0 ? ` (${taskCount} task(s))` : ''}`);
          }
          parts.push('');
        }

        if (released.length > 0) {
          const latest = released[0];
          const ver = String(latest.version ?? '');
          const relDate = String(latest.date ?? '');
          const sum = String(latest.summary ?? '');
          const taskCount = Array.isArray(latest.tasks) ? latest.tasks.length : 0;
          const featCount = Array.isArray(latest.features) ? latest.features.length : 0;
          const brk = latest.breaking ? ' (BREAKING)' : '';
          parts.push('## Latest Release\n');
          parts.push(`- ${ver} (${relDate})${brk}: ${sum}`);
          if (taskCount > 0 || featCount > 0) {
            parts.push(`  Includes: ${taskCount} task(s), ${featCount} feature(s)`);
          }
          parts.push('');
        }
      }
    } catch {
      // skip if malformed
    }
  }
  flush('releases', { neverEvict: true });

  // 8. Features summary (with Why, related tasks, and latest changelog).
  // Demotion: active + recently-updated features keep their detail block; the
  // rest collapse to a name+status+path line (PRD is one Read away).
  const featuresDir = join(root, 'core', 'features');
  if (existsSync(featuresDir)) {
    const featureFiles = fg.sync('*.md', { cwd: featuresDir, absolute: true });
    const features: string[] = [];
    const featureMeta: Array<{ detail: string; nameLine: string; status: string; updated: string }> = [];

    for (const file of featureFiles) {
      try {
        const { data } = readFrontmatter(file);
        const name = basename(file, '.md');
        const status = String(data.status ?? 'unknown');
        const tags = Array.isArray(data.tags) ? data.tags.join(', ') : '';

        // Why (from ## Why section, first real line; HTML template comments stripped)
        let why = '';
        try {
          const whyContent = readSection(file, 'Why');
          if (whyContent) {
            const stripped = whyContent.replace(/<!--[\s\S]*?-->/g, '');
            const firstLine = stripped.split('\n').find(l => l.trim() && !l.trim().startsWith('('))?.trim();
            if (firstLine) {
              why = firstLine.length > 250 ? firstLine.slice(0, 247) + '...' : firstLine;
            }
          }
        } catch { /* skip */ }

        // Related tasks (from frontmatter)
        const relatedTasks = Array.isArray(data.related_tasks) && data.related_tasks.length > 0
          ? data.related_tasks.join(', ')
          : '';

        // Latest changelog entry (from ## Changelog section)
        let latest = '';
        try {
          const changelogContent = readSection(file, 'Changelog');
          if (changelogContent) {
            const lines = changelogContent.split('\n');
            const headerLine = lines.find(l => l.startsWith('### '));
            if (headerLine) {
              const header = headerLine.replace(/^###\s*/, '').trim();
              if (!header.endsWith('- Created')) {
                const bulletIdx = lines.indexOf(headerLine) + 1;
                const bullet = lines.slice(bulletIdx).find(l => l.trim().startsWith('-'));
                if (bullet) {
                  const entry = `${header.split(' - ')[0]} - ${bullet.trim().replace(/^-\s*/, '')}`;
                  latest = entry.length > 120 ? entry.slice(0, 117) + '...' : entry;
                }
              }
            }
          }
        } catch { /* skip */ }

        // Build output
        const freshness = computeFeatureFreshness(
          String(data.created ?? ''),
          String(data.updated ?? ''),
        );
        const freshnessNote = freshnessSnapshotNote(freshness);
        let featureLine = `- **${name}** (status: ${status}${tags ? `, tags: ${tags}` : ''})${freshnessNote}`;
        const details: string[] = [];
        if (why) details.push(`  Why: ${why}`);
        if (relatedTasks) details.push(`  Tasks: ${relatedTasks}`);
        if (latest) details.push(`  Latest: ${latest}`);

        if (details.length > 0) {
          featureLine += '\n' + details.join('\n');
        }
        features.push(featureLine);
        featureMeta.push({
          detail: featureLine,
          nameLine: `- **${name}** (status: ${status}) -> _dream_context/core/features/${name}.md`,
          status,
          updated: String(data.updated ?? data.created ?? ''),
        });
      } catch {
        // skip unreadable files
      }
    }

    if (features.length > 0) {
      parts.push('## Features\n');
      parts.push(features.join('\n'));
      parts.push('');
      const activeFirst = [...featureMeta].sort((a, b) => {
        const rank = (s: string): number =>
          s === 'in_progress' || s === 'active' ? 0 : s === 'planned' || s === 'todo' ? 1 : 2;
        return rank(a.status) - rank(b.status) || b.updated.localeCompare(a.updated);
      });
      const renderFeatures = (detailCount: number): string => {
        const lines = activeFirst.map((f, i) => (i < detailCount ? f.detail : f.nameLine));
        return ['## Features\n', lines.join('\n'), ''].join('\n');
      };
      flush('features', { demotions: [renderFeatures(8), renderFeatures(0)] });
    }
  }

  // 9. Knowledge Index + Pinned Knowledge
  const knowledgeEntries = buildKnowledgeIndex(root);
  if (knowledgeEntries.length > 0) {
    const indexLines: string[] = [];
    const compactLines: string[] = [];
    const pinnedEntries: typeof knowledgeEntries = [];
    const warmEntries: typeof knowledgeEntries = [];

    // Gather active task tags for warm knowledge matching
    const activeTaskTags: string[] = [];
    const stDir = join(root, 'state');
    if (existsSync(stDir)) {
      const tFiles = fg.sync('*.md', { cwd: stDir, absolute: true });
      for (const file of tFiles) {
        try {
          const { data } = readFrontmatter(file);
          if (String(data.status ?? '') === 'completed') continue;
          if (Array.isArray(data.tags)) {
            activeTaskTags.push(...data.tags.map((t: string) => String(t).toLowerCase()));
          }
        } catch { /* skip */ }
      }
    }

    for (const entry of knowledgeEntries) {
      const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
      // Staleness indicator
      const accessRecord = sleepState.knowledge_access[entry.slug];
      let stalenessNote = '';
      if (accessRecord) {
        const daysSince = Math.floor((Date.now() - new Date(accessRecord.last_accessed).getTime()) / (1000 * 60 * 60 * 24));
        if (daysSince > 30) {
          stalenessNote = ' (stale: not accessed in 30+ days)';
        }
      } else if (entry.date) {
        const daysSinceCreation = Math.floor((Date.now() - new Date(entry.date).getTime()) / (1000 * 60 * 60 * 24));
        if (daysSinceCreation > 30) {
          stalenessNote = ' (stale: never accessed)';
        }
      }

      indexLines.push(`- **${entry.slug}** (_dream_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}${stalenessNote}`);
      compactLines.push(`- **${entry.slug}**${tagsStr}${stalenessNote ? ' (stale)' : ''}`);
      if (entry.pinned) {
        pinnedEntries.push(entry);
      } else if (!stalenessNote) {
        // Warm candidate: recently accessed or task-relevant
        const isRecentlyAccessed = accessRecord && accessRecord.count > 0 &&
          (Date.now() - new Date(accessRecord.last_accessed).getTime()) < 7 * 24 * 60 * 60 * 1000; // 7 days
        const isTaskRelevant = entry.tags.some(t => activeTaskTags.includes(t.toLowerCase()));
        if (isRecentlyAccessed || isTaskRelevant) {
          warmEntries.push(entry);
        }
      }
    }

    parts.push('## Knowledge Index\n');

    // Pinned entries surface at the TOP with a prominent warning. Body is
    // intentionally NOT inlined — `memory recall` fetches on demand and the
    // agent can Read the file when the warning applies.
    if (pinnedEntries.length > 0) {
      parts.push('> !!! ÇOK ÖNEMLİ !!! Kullanıcı bu bilgiyi pinlemiş — yapacağın bir işle ilişkisi varsa MUTLAKA OKU!\n');
      for (const entry of pinnedEntries) {
        const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
        parts.push(`- 📌 **${entry.slug}** (_dream_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}`);
      }
      parts.push('');
    }

    const pinnedSlugs = new Set(pinnedEntries.map(e => e.slug));
    const nonPinnedLines = indexLines.filter((_, i) => !pinnedSlugs.has(knowledgeEntries[i]?.slug));
    if (nonPinnedLines.length > 0) {
      if (pinnedEntries.length > 0) parts.push('### Other knowledge:\n');
      parts.push(nonPinnedLines.join('\n'));
    }
    parts.push('');
    {
      // Demoted index: pinned entries keep their full warning block; non-pinned
      // entries drop descriptions but keep slug + tags (the discovery surface
      // survives — descriptions come back via `dreamcontext knowledge index`).
      const compactNonPinned = compactLines.filter((_, i) => !pinnedSlugs.has(knowledgeEntries[i]?.slug));
      const compact: string[] = ['## Knowledge Index\n'];
      if (pinnedEntries.length > 0) {
        compact.push('> !!! ÇOK ÖNEMLİ !!! Kullanıcı bu bilgiyi pinlemiş — yapacağın bir işle ilişkisi varsa MUTLAKA OKU!\n');
        for (const entry of pinnedEntries) {
          const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
          compact.push(`- 📌 **${entry.slug}** (_dream_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}`);
        }
        compact.push('');
        compact.push('### Other knowledge:\n');
      }
      compact.push('(slugs only — files at _dream_context/knowledge/<slug>.md; descriptions via `dreamcontext knowledge index` or memory recall)');
      compact.push(compactNonPinned.join('\n'));
      compact.push('');
      flush('knowledge-index', { demotions: [compact.join('\n')] });
    }

    // 9.5 Warm Knowledge (recently relevant, first paragraph only)
    if (warmEntries.length > 0) {
      // Option A (maintainer decision): no pinned-preview inline feature built.
      // entry.content is already extracted text (not scene JSON) for Excalidraw
      // boards — see knowledge-index.ts. So extractFirstParagraph(entry.content)
      // here and the token estimate are always JSON-free and size-independent.
      // A 2MB-scene board and a tiny-scene board with identical Text Elements
      // yield equal token estimates. No functional change needed.
      const renderWarm = (cap: number): string[] => {
        const out: string[] = ['## Warm Knowledge (Recently Relevant)\n'];
        for (const entry of warmEntries.slice(0, cap)) {
          out.push(`### ${entry.name}`);
          const firstParagraph = extractFirstParagraph(entry.content);
          if (firstParagraph) {
            out.push(firstParagraph);
          }
          out.push(`-> Read full: _dream_context/knowledge/${entry.slug}.md`);
          out.push('');
        }
        if (warmEntries.length > cap) {
          out.push(`(+${warmEntries.length - cap} more warm file(s) — listed in the Knowledge Index above)`);
          out.push('');
        }
        return out;
      };
      parts.push(...renderWarm(warmEntries.length));
      flush('warm-knowledge', {
        demotions: [
          renderWarm(4).join('\n'),
          '(Warm knowledge omitted for budget — the Knowledge Index above lists every file; recall surfaces them on demand.)\n',
        ],
      });
    }
  }

  // 11. Marketing snapshot (skill-pack scoped — only present when bootstrapped)
  try {
    const marketing = buildMarketingSnapshot();
    if (marketing) {
      parts.push(marketing);
      parts.push('');
    }
  } catch {
    // Marketing snapshot must never break the SessionStart hook.
  }
  flush('marketing', { neverEvict: true });

  // 12. Federation inbox note — HOT-PATH SAFE. A single LOCAL readdir
  // (`pendingInboxCount`) counts pending peer digest entries; it NEVER resolves
  // a peer vault or builds a peer corpus (issue #25 LOCKED hot-path invariant).
  // Surfaces a one-line nudge so the next sleep cycle drains the inbox.
  const pendingFederation = pendingInboxCount(root);
  if (pendingFederation > 0) {
    parts.push(
      `## Federation\n\n${pendingFederation} pending peer digest ` +
        `entr${pendingFederation === 1 ? 'y' : 'ies'} in the inbox — run \`dreamcontext federation drain\` ` +
        `(or let the next sleep cycle drain them).\n`,
    );
    flush('federation', { neverEvict: true });
  }

  // 13. Connected projects — AMBIENT READ AWARENESS, HOT-PATH SAFE. Built PURELY
  // from `readPeerSummaryCache(root)`: a single LOCAL file read of
  // state/.peer-summaries.json in the CURRENT vault. NO peer resolution, NO peer
  // corpus build — the cache is refreshed OFF the hot path (by `federation
  // peers`, the sleep-federation cycle, and connect/disconnect). If the cache is
  // absent or empty, the section is omitted entirely (issue #25 LOCKED hot-path
  // invariant: no cross-vault work in generateSnapshot).
  const peerCache = readPeerSummaryCache(root);
  if (peerCache && peerCache.peers.length > 0) {
    const lines: string[] = ['## Connected projects\n'];
    lines.push(
      'These projects are READABLE from here (out/both connection + shareable). ' +
        'Recall already spans them; you have ambient awareness of what each is and what was last done there.\n',
    );
    for (const p of peerCache.peers) {
      let head = `- **${p.vault}**`;
      if (p.whatItIs) head += ` — ${p.whatItIs}`;
      lines.push(head);
      for (const act of p.lastActivity) lines.push(`  Last: ${act}`);
      if (p.activeTask) lines.push(`  In progress: ${p.activeTask}`);
      if (p.topTags.length > 0) lines.push(`  Tags: ${p.topTags.join(', ')}`);
    }
    lines.push('');
    lines.push(
      'Recall already spans these. To search one directly: ' +
        '`dreamcontext memory recall <q> --vault <name>`.',
    );
    lines.push('');
    parts.push(lines.join('\n'));
    flush('connected-projects', { neverEvict: true });
  }

  // Final assembly through the token budget (see snapshot-budget.ts). The
  // demotion ladder only engages when the full render exceeds the budget;
  // under budget the output is byte-identical to the legacy format.
  const budget = resolveBudget(process.env.DREAMCONTEXT_SNAPSHOT_BUDGET);
  return applyBudget(sections, budget).text.trim();
}

/**
 * Output a lightweight context briefing for sub-agents.
 * Lighter than generateSnapshot(): no soul/user/memory content, no sleep state,
 * no changelog, no features detail. Includes project summary, active tasks,
 * knowledge index, and pinned knowledge.
 * Plain text, no chalk — consumed by SubagentStart hook.
 */
export function generateSubagentBriefing(): string {
  const root = resolveContextRoot();
  if (!root) return '';

  const parts: string[] = ['# Agent Context -- Sub-agent Briefing\n'];

  // 1. Top-priority directive (MUST be first thing the sub-agent reads)
  parts.push('MANDATORY: This project has documented context files. You MUST check the feature list');
  parts.push('and knowledge index below BEFORE using Glob, Grep, or searching code. If any feature');
  parts.push('name or tag matches your task, Read that feature file first. Searching the codebase');
  parts.push('without checking context wastes tokens and duplicates existing documentation.\n');

  // 1b. Recall directive — applies to EVERY sub-agent type, not just dreamcontext-explore,
  // and does not depend on this briefing being honoured (the agent runs recall itself).
  parts.push('RECALL: For any "where / why / what do we know about X" question, run');
  parts.push('`dreamcontext memory recall "<keywords>"` (BM25 over knowledge/features/tasks/');
  parts.push('memory/changelog, <100ms, zero token overhead) BEFORE Glob/Grep — it frequently');
  parts.push('beats blind exploration outright.\n');

  // 2. Project summary (first meaningful line from soul file content)
  const soulPath = join(root, 'core', '0.soul.md');
  if (existsSync(soulPath)) {
    const { data, content } = readFrontmatter(soulPath);
    const projectName = typeof data.name === 'string' ? data.name : '';
    const lines = content.split('\n');
    const summaryLine = lines.find(l => {
      const t = l.trim();
      return t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('<!--') && !t.startsWith('---');
    });
    if (projectName || summaryLine) {
      let summary = projectName ? `**${projectName}**` : '';
      if (summaryLine) {
        const trimmed = summaryLine.trim();
        const capped = trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed;
        summary += summary ? `: ${capped}` : capped;
      }
      parts.push(`Project: ${summary}\n`);
    }
  }

  // 3. Features summary (name, status, tags, why, related tasks)
  // Features come FIRST because they're the most actionable context for sub-agents.
  const featuresDir = join(root, 'core', 'features');
  if (existsSync(featuresDir)) {
    const featureFiles = fg.sync('*.md', { cwd: featuresDir, absolute: true });
    const features: string[] = [];

    for (const file of featureFiles) {
      try {
        const { data } = readFrontmatter(file);
        const name = basename(file, '.md');
        const status = String(data.status ?? 'unknown');
        const tags = Array.isArray(data.tags) ? data.tags.join(', ') : '';

        let why = '';
        try {
          const whyContent = readSection(file, 'Why');
          if (whyContent) {
            const firstLine = whyContent.split('\n').find(l => l.trim() && !l.trim().startsWith('('))?.trim();
            if (firstLine) {
              why = firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
            }
          }
        } catch { /* skip */ }

        const relatedTasks = Array.isArray(data.related_tasks) && data.related_tasks.length > 0
          ? data.related_tasks.join(', ')
          : '';

        let featureLine = `- **${name}** --> Read: _dream_context/core/features/${name}.md`;
        const details: string[] = [];
        if (tags) details.push(`  Tags: ${tags}`);
        if (why) details.push(`  Why: ${why}`);
        if (relatedTasks) details.push(`  Tasks: ${relatedTasks}`);

        if (details.length > 0) {
          featureLine += '\n' + details.join('\n');
        }
        features.push(featureLine);
      } catch {
        // skip unreadable files
      }
    }

    if (features.length > 0) {
      parts.push('## Features (read these BEFORE searching code)\n');
      parts.push(features.join('\n'));
      parts.push('');
    }
  }

  // 4. Knowledge Index + Pinned Knowledge
  const knowledgeEntries = buildKnowledgeIndex(root);
  if (knowledgeEntries.length > 0) {
    const indexLines: string[] = [];
    const pinnedEntries: typeof knowledgeEntries = [];

    for (const entry of knowledgeEntries) {
      const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
      indexLines.push(`- **${entry.slug}** (_dream_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}`);
      if (entry.pinned) {
        pinnedEntries.push(entry);
      }
    }

    parts.push('## Knowledge Index\n');

    if (pinnedEntries.length > 0) {
      parts.push('> !!! ÇOK ÖNEMLİ !!! Kullanıcı bu bilgiyi pinlemiş — yapacağın bir işle ilişkisi varsa MUTLAKA OKU!\n');
      for (const entry of pinnedEntries) {
        const tagsStr = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : '';
        parts.push(`- 📌 **${entry.slug}** (_dream_context/knowledge/${entry.slug}.md): ${entry.description}${tagsStr}`);
      }
      parts.push('');
    }

    const pinnedSlugs2 = new Set(pinnedEntries.map(e => e.slug));
    const nonPinnedLines2 = indexLines.filter((_, i) => !pinnedSlugs2.has(knowledgeEntries[i]?.slug));
    if (nonPinnedLines2.length > 0) {
      if (pinnedEntries.length > 0) parts.push('### Other knowledge:\n');
      parts.push(nonPinnedLines2.join('\n'));
    }
    parts.push('');
  }

  // 5. All Core Files index (so sub-agents know what exists to read/update)
  const coreDir = join(root, 'core');
  if (existsSync(coreDir)) {
    const allCoreFiles = fg.sync(['[0-9]*'], { cwd: coreDir, absolute: true });
    allCoreFiles.sort((a, b) => basename(a).localeCompare(basename(b), undefined, { numeric: true }));

    if (allCoreFiles.length > 0) {
      parts.push('## Core Files\n');
      for (const file of allCoreFiles) {
        const filename = basename(file);
        const relativePath = `_dream_context/core/${filename}`;

        if (filename.endsWith('.json')) {
          const name = filename.replace(/^\d+\./, '').replace(/\.\w+$/, '').replace(/_/g, ' ');
          parts.push(`- **${name}** (${relativePath})`);
          continue;
        }

        try {
          const { data } = readFrontmatter(file);
          const name = String(data.name ?? filename);
          const summary = data.summary ? `: ${String(data.summary)}` : '';
          parts.push(`- **${name}** (${relativePath})${summary}`);
        } catch {
          parts.push(`- **${filename}** (${relativePath})`);
        }
      }
      parts.push('');
    }
  }

  // 6. Active tasks (sub-agent briefings stay lean: activity-sorted, capped at
  // 12 — sub-agents are task-scoped and never need the full backlog)
  const activeTasks = sortTaskEntriesByActivity(getActiveTaskEntries(root)).map((t) => t.text);
  if (activeTasks.length > 0) {
    parts.push('## Active Tasks\n');
    parts.push(demoteTaskList(activeTasks, 12).join('\n'));
    parts.push('');
  }

  // 7. Task-awareness instruction (for Plan agents and all sub-agents)
  parts.push('## Task Awareness\n');
  parts.push('All significant work should be linked to a task in `_dream_context/state/`.');
  parts.push('If you are creating a plan or completing an implementation:');
  parts.push('- Check if an existing task in Active Tasks above relates to this work');
  parts.push('- If planning: after the plan is approved, ask the user: "Would you like to save this plan as an dreamcontext task?"');
  parts.push('- To create: `dreamcontext tasks create <name> --status pending --priority <p> --tags <t>`');
  parts.push('- To log progress: `dreamcontext tasks log <name> "what was done"`');
  parts.push('Untracked work gets lost across sessions. Tasks are how knowledge persists.');
  parts.push('');

  // 8. Context directory reference
  parts.push('## Context Directory\n');
  parts.push('`_dream_context/core/` -- Core files: soul (0), user (1), memory (2), extended (3+), features/');
  parts.push('`_dream_context/knowledge/` -- Deep research documents on specific topics');
  parts.push('`_dream_context/state/` -- Active task files with progress logs');
  parts.push('');

  return parts.join('\n').trim();
}

export function registerSnapshotCommand(program: Command): void {
  program
    .command('snapshot')
    .description('Output a context snapshot for SessionStart hook (plain text, no colors)')
    .option('--tokens', 'Show estimated token count instead of snapshot content')
    .option('--vault <name>', 'Print a peer vault\'s snapshot (registered name or path)')
    .action((opts: { tokens?: boolean; vault?: string }) => {
      // Federation P1.4: `--vault` prints a PEER snapshot via the vault registry.
      // A bad name/path yields a clean VaultError message + non-zero exit (no
      // stack). The default (no --vault) path is untouched.
      let rootOverride: string | undefined;
      if (opts.vault !== undefined) {
        try {
          rootOverride = resolveVaultContextRoot(opts.vault);
        } catch (err) {
          error(err instanceof VaultError ? err.message : `Could not resolve vault: ${String(err)}`);
          process.exit(1);
        }
      }

      const output = generateSnapshot(rootOverride);
      if (!output) return;

      if (opts.tokens) {
        // Rough estimate: ~4 chars per token for English text
        const estimated = Math.ceil(output.length / 4);
        console.log(String(estimated));
      } else {
        console.log(output);
      }
    });
}
