import { SESSION_START_PART_HOOK } from '../../lib/hook-delivery.js';
import { SESSION_START_PARTS } from '../../lib/snapshot-budget.js';
import { Command, Option } from 'commander';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, readdirSync, cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { relPosix } from '../../lib/paths.js';
import { CODEX_GATE_SPEC, codexHookCommand } from '../../lib/t3-bridge/codex-user-gate.js';
import chalk from 'chalk';
import { checkbox, confirm } from '@inquirer/prompts';
import { error, info, warn, miniBox, header } from '../../lib/format.js';
import {
  PLATFORM_CATALOG,
  ensurePlatformSelection,
  formatSupportedPlatforms,
  parsePlatformList,
  type PlatformId,
} from '../../lib/platforms.js';
import {
  readProjectPlatformDefaults,
  writeProjectPlatformDefaults,
  getPlatformDefaultsPath,
} from '../../lib/platform-defaults.js';
import {
  readManifest,
  writeManifest,
  recordFile,
  recordPlatform,
  emptyManifest,
  dreamcontextVersion,
  PRE_MANIFEST_VERSION,
  type Manifest,
  type ManagedFileKind,
} from '../../lib/manifest.js';
import { readSetupConfig } from '../../lib/setup-config.js';
import { migrateThenStampSetupVersion } from '../../lib/migrate-and-stamp.js';
import { applyClaudeAutoMemory } from '../../lib/claude-settings.js';
import { syncPeerAgents } from '../../lib/peer-agent-gen.js';
import { syncPatternShims } from '../../lib/patterns.js';

// ─── Hook Constants (Claude) ───────────────────────────────────────────────

/**
 * The command Claude Code runs for one hook event.
 *
 * A `dreamcontext` on PATH runs directly; only without one does the hook fall back to `npx`,
 * whose package resolution cost ~0.5 s and a second node process (~60 MB) on EVERY event, and
 * with ten agents at work that was the machine's second-largest load. No absolute path: the
 * settings file is committed and shared, so the command must work on any machine. `exec`
 * replaces the shell, so the hook's own exit code and stdout reach Claude Code unchanged.
 *
 * Mirrored in skill/SKILL.md's frontmatter `hooks:` (Claude Code dedupes identical commands, so
 * a skill copy that drifted would run every event twice); tests/unit/install-skill-hooks.test.ts
 * holds the two together.
 */
export function hookCommand(event: string): string {
  return `command -v dreamcontext >/dev/null 2>&1 && exec dreamcontext hook ${event} || exec npx dreamcontext hook ${event}`;
}

/** The command every installer before {@link hookCommand} wrote; rewritten in place on update. */
export function legacyHookCommand(event: string): string {
  return `npx dreamcontext hook ${event}`;
}

const SESSION_START_HOOK = hookCommand('session-start');
const STOP_HOOK = hookCommand('stop');
const SUBAGENT_START_HOOK = hookCommand('subagent-start');
const PRE_TOOL_USE_HOOK = hookCommand('pre-tool-use');
const USER_PROMPT_SUBMIT_HOOK = hookCommand('user-prompt-submit');
const POST_TOOL_USE_HOOK = hookCommand('post-tool-use');
const PRE_COMPACT_HOOK = hookCommand('pre-compact');
const ENSURE_DASHBOARD_HOOK = hookCommand('ensure-dashboard');
const OLD_HOOK = 'npx dreamcontext snapshot'; // migration target
const SESSION_START_MATCHER = 'startup|resume|compact|clear';
/** Claude Code reads a matcher with anything but letters, digits and `|` as a regex against the tool
 *  name; every MCP tool is `mcp__<server>__<tool>`, so this reaches them and no built-in tool. */
export const MCP_TOOL_MATCHER = 'mcp__.*';

/**
 * The 0.33.0 task system (reverted 2026-10-20) installed two hooks this version does not run:
 * the sub-task Read guard, a script in `.claude/hooks/` that calls `dreamcontext hook read-task`,
 * and `dreamcontext hook session-end`. Neither subcommand exists here, so a project 0.33.0 set
 * up would keep a hook that fails on every session end. `update` removes both.
 */
export const RETIRED_READ_TASK_GUARD_FILE = 'read-task-guard.cjs';
const RETIRED_HOOK_COMMANDS = new Set([
  `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${RETIRED_READ_TASK_GUARD_FILE}"`,
  hookCommand('session-end'),
  legacyHookCommand('session-end'),
]);

// ─── Hook Types ─────────────────────────────────────────────────────────────

interface HookHandler {
  type: string;
  command: string;
  timeout?: number;
  [key: string]: unknown;
}

interface MatcherGroup {
  matcher?: string;
  hooks: HookHandler[];
}

interface SettingsJson {
  hooks?: Record<string, MatcherGroup[]>;
  [key: string]: unknown;
}

interface HookSpec {
  event: string;
  /** The `dreamcontext hook <name>` subcommand; the installed command is {@link hookCommand}(name). */
  name: string;
  command: string;
  timeout: number;
  matcher?: string;
}

export const HOOK_SPECS: readonly HookSpec[] = [
  { event: 'SessionStart', name: 'session-start', command: SESSION_START_HOOK, timeout: 10, matcher: SESSION_START_MATCHER },
  // The snapshot's later pieces. One hook carries at most HARNESS_PERSIST_CHAR_LIMIT, so these run
  // beside session-start and print what it left them (lib/hook-delivery.ts). An older CLI has no such
  // subcommand: the hook fails on its own and session-start still works.
  ...Array.from({ length: SESSION_START_PARTS - 1 }, (_, i) => {
    const name = `${SESSION_START_PART_HOOK} ${i + 2}`;
    return { event: 'SessionStart', name, command: hookCommand(name), timeout: 10, matcher: SESSION_START_MATCHER };
  }),
  // 45 s, not 5: a TS project whose check takes over 4 s is type-checked once per turn, at Stop
  // (lib/tsc-check.ts), and a hook killed by its timeout loses its answer.
  { event: 'Stop', name: 'stop', command: STOP_HOOK, timeout: 45 },
  // 10 s, not 5: under load a hook killed by its timeout left the sub-agent with no briefing at all.
  { event: 'SubagentStart', name: 'subagent-start', command: SUBAGENT_START_HOOK, timeout: 10 },
  { event: 'PreToolUse', name: 'pre-tool-use', command: PRE_TOOL_USE_HOOK, timeout: 5, matcher: 'Agent' },
  // Second PreToolUse entry: gates direct writes to protected files (e.g. marketing/.env).
  // The hook.ts action already branches on tool_name, so the same command serves both gates.
  { event: 'PreToolUse', name: 'pre-tool-use', command: PRE_TOOL_USE_HOOK, timeout: 5, matcher: 'Edit|Write|MultiEdit' },
  // Third: the same gate for a shell write. A member's file (`agents/*.md`, `automations/*.md`) was
  // once appended to from a heredoc, which dropped its approval (`member-file-guard.ts`).
  // (Also) a heavy shell step goes through `builder heavy` (lock + repeat limit, lib/run-budget.ts).
  { event: 'PreToolUse', name: 'pre-tool-use', command: PRE_TOOL_USE_HOOK, timeout: 5, matcher: 'Bash' },
  // Fourth: MCP tools, only so the grant gate (hook.ts `allow()`, uye-bildirim K3) can see them. The
  // owner's "Allow once" or "For this job" on a refused MCP call is written to the grant store, and
  // without this matcher the hook never ran for that call, so the grant could never be used. No
  // deny gate reads an MCP tool name: the call falls through to `allow()`, and an unbound session
  // pays one failed binding lookup. The narrowest matcher that covers every `mcp__<server>__<tool>`.
  { event: 'PreToolUse', name: 'pre-tool-use', command: PRE_TOOL_USE_HOOK, timeout: 5, matcher: MCP_TOOL_MATCHER },
  { event: 'UserPromptSubmit', name: 'user-prompt-submit', command: USER_PROMPT_SUBMIT_HOOK, timeout: 120 },
  { event: 'PostToolUse', name: 'post-tool-use', command: POST_TOOL_USE_HOOK, timeout: 30, matcher: 'Edit|Write' },
  { event: 'PreCompact', name: 'pre-compact', command: PRE_COMPACT_HOOK, timeout: 5 },
  // Auto-open the dashboard when a session starts and no server is already up.
  // Separate SessionStart group (own matcher) so it does NOT fire on compaction —
  // mid-session compaction should not relaunch the dashboard. Opt out with
  // DREAMCONTEXT_AUTO_DASHBOARD=0.
  { event: 'SessionStart', name: 'ensure-dashboard', command: ENSURE_DASHBOARD_HOOK, timeout: 10, matcher: 'startup|resume' },
];

// ─── Catalog Types ──────────────────────────────────────────────────────────

// ─── Platform Helpers ───────────────────────────────────────────────────────

function platformLabel(_platform: PlatformId): string {
  return 'Claude';
}

function platformPrefixed(platform: PlatformId, relPath: string): string {
  return `${chalk.dim(`[${platform}]`)} ${relPath}`;
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

function parsePlatformsOption(raw?: string): PlatformId[] {
  if (!raw) return [];
  const parsed = parsePlatformList(raw);
  if (parsed.invalid.length > 0) {
    throw new Error(
      `Unknown platform(s): ${parsed.invalid.join(', ')}. Supported: ${formatSupportedPlatforms()}`,
    );
  }
  return ensurePlatformSelection(parsed.platforms);
}

async function resolvePlatforms(projectRoot: string, raw?: string): Promise<PlatformId[]> {
  const explicit = parsePlatformsOption(raw);
  if (explicit.length > 0) return explicit;

  const defaults = readProjectPlatformDefaults(projectRoot);
  if (!process.stdin.isTTY) {
    return defaults;
  }

  const selected = await checkbox<PlatformId>({
    message: 'Select platform support to install',
    choices: PLATFORM_CATALOG.map((p) => ({
      value: p.id,
      name: `${chalk.bold(p.label)} ${chalk.dim('— ' + p.description)}`,
      checked: defaults.includes(p.id),
    })),
    pageSize: PLATFORM_CATALOG.length,
  });

  const platforms = ensurePlatformSelection(selected);
  const defaultsPath = getPlatformDefaultsPath(projectRoot);
  if (defaultsPath && !arraysEqual(platforms, defaults)) {
    const shouldSave = await confirm({
      message: `Save selected platforms as project defaults (${platforms.join(', ')})?`,
      default: true,
    });
    if (shouldSave) {
      writeProjectPlatformDefaults(projectRoot, platforms);
      info(`Saved platform defaults to ${chalk.dim(defaultsPath)}`);
    }
  }

  return platforms;
}

// ─── Hook Installation (Claude) ────────────────────────────────────────────

/**
 * Delete the 0.33.0 Read guard script. Only a regular file that is still the guard dreamcontext
 * wrote goes: a symlink is never followed, a file of the same name that someone else wrote stays.
 * The `.claude/hooks/` folder goes too when the guard was all it held.
 */
function removeRetiredReadTaskGuard(projectRoot: string): void {
  const dir = join(projectRoot, '.claude', 'hooks');
  const file = join(dir, RETIRED_READ_TASK_GUARD_FILE);
  try {
    if (!lstatSync(file).isFile()) return;
    if (!readFileSync(file, 'utf-8').includes('dreamcontext Read-hook guard')) return;
    rmSync(file);
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  } catch {
    /* absent or unreadable: nothing to remove */
  }
}

/**
 * Ensure all dreamcontext hooks are installed.
 * Migrates old `npx dreamcontext snapshot` hook if present, and rewrites a handler an older
 * installer wrote (`npx dreamcontext hook <name>`) IN PLACE to {@link hookCommand}: matching on
 * the new string alone would add a second handler beside the old one and run every event twice.
 */
/** The command Codex runs for one hook event: the same CLI hook, printed in Codex's shape. */
export { codexHookCommand };

/**
 * Codex's hook events → our handlers, for `.codex/hooks.json` (Claude-compatible shape). No
 * PostToolUse: the formatter/type-check hook is Claude's (Codex runs its own tooling). Inside a
 * desktop Codex chat these stay quiet except pre-tool-use (DREAMCONTEXT_CONTEXT_BY, hook.ts).
 */
export const CODEX_HOOK_SPECS: readonly { event: string; name: string; timeout: number; matcher?: string }[] = [
  { event: 'SessionStart', name: 'session-start', timeout: 10, matcher: 'startup|resume|compact|clear' },
  { event: 'UserPromptSubmit', name: 'user-prompt-submit', timeout: 120 },
  { event: 'PreToolUse', name: 'pre-tool-use', timeout: 5 },
  { event: 'PreCompact', name: 'pre-compact', timeout: 5 },
  { event: 'SubagentStart', name: 'subagent-start', timeout: 5 },
  { event: 'Stop', name: 'stop', timeout: 45 },
];

const isOurCodexHook = (cmd: unknown): boolean => typeof cmd === 'string' && /dreamcontext hook [a-z-]+ --format codex/.test(cmd);

/**
 * Write or refresh our entries in `<project>/.codex/hooks.json`; idempotent. Every entry that is
 * not ours (another tool's, the owner's) is kept as it is; ours are recognised by their command.
 */
export function ensureCodexHooks(projectRoot: string): { file: string; changed: boolean } {
  return writeCodexHooks(join(projectRoot, '.codex', 'hooks.json'), CODEX_HOOK_SPECS);
}

/** The one Mac-wide gate in `<codex home>/hooks.json`. Only the gate: the brain hooks stay opt-in. */
export function ensureCodexUserGate(codexHome: string): { file: string; changed: boolean } {
  return writeCodexHooks(join(codexHome, 'hooks.json'), [CODEX_GATE_SPEC]);
}

function writeCodexHooks(file: string, specs: readonly { event: string; name: string; timeout: number; matcher?: string; command?: string }[]): { file: string; changed: boolean } {
  let doc: { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>> } & Record<string, unknown> = {};
  const before = existsSync(file) ? readFileSync(file, 'utf-8') : '';
  if (before.trim()) {
    try { doc = JSON.parse(before); } catch { throw new Error(`${file} is not valid JSON; fix or move it, then run this again (nothing was written).`); }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${file} is not a JSON object; nothing was written.`);
  }
  const hooks: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; timeout?: number }> }>> = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
  // Drop our previous entries (a group left empty by that goes too), then add the current set.
  for (const event of Object.keys(hooks)) {
    const groups = Array.isArray(hooks[event]) ? hooks[event]! : [];
    hooks[event] = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurCodexHook(h.command)) }))
      .filter((g) => (g.hooks ?? []).length > 0);
    if (hooks[event]!.length === 0) delete hooks[event];
  }
  for (const spec of specs) {
    const group = { ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [{ type: 'command', command: spec.command ?? codexHookCommand(spec.name), timeout: spec.timeout }] };
    (hooks[spec.event] ??= []).push(group);
  }
  doc.hooks = hooks;
  const after = JSON.stringify(doc, null, 2) + '\n';
  if (after === before) return { file, changed: false };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, after, 'utf-8');
  return { file, changed: true };
}

export function ensureClaudeHooks(projectRoot: string): { added: string[]; updated: string[]; migrated: boolean } {
  const settingsPath = join(projectRoot, '.claude', 'settings.json');
  const result = { added: [] as string[], updated: [] as string[], migrated: false };

  let settings: SettingsJson = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      settings = {};
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  // Migration: remove old `npx dreamcontext snapshot` hook from SessionStart
  if (settings.hooks.SessionStart) {
    const oldIdx = settings.hooks.SessionStart.findIndex((group) =>
      group.hooks?.some((h) => h.command === OLD_HOOK),
    );
    if (oldIdx !== -1) {
      settings.hooks.SessionStart.splice(oldIdx, 1);
      result.migrated = true;
    }
  }

  // Migration: drop the hooks the reverted 0.33.0 task system installed, and its guard script.
  for (const event of Object.keys(settings.hooks)) {
    const groups = settings.hooks[event];
    if (!Array.isArray(groups)) continue;
    let removed = false;
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => !RETIRED_HOOK_COMMANDS.has(h.command));
      if (group.hooks.length !== before) removed = true;
    }
    if (!removed) continue;
    result.migrated = true;
    const kept = groups.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    if (kept.length) settings.hooks[event] = kept;
    else delete settings.hooks[event];
  }
  removeRetiredReadTaskGuard(projectRoot);

  // Register all hooks via data-driven loop.
  // Dedup key is (command, matcher) — two entries with the same command but
  // different matchers are intentionally distinct (e.g. the two PreToolUse
  // entries: one for 'Agent' gate and one for 'Edit|Write|MultiEdit' gate).
  for (const spec of HOOK_SPECS) {
    if (!settings.hooks[spec.event]) {
      settings.hooks[spec.event] = [];
    }
    // Find the existing managed handler (matched on command + matcher) so we can
    // both detect presence AND reconcile its timeout. Without reconciliation a
    // project written by an older installer keeps its stale timeout forever —
    // e.g. UserPromptSubmit installed at 5s before the Haiku recall path (which
    // can take ~15s) made the larger 120s timeout necessary, so the hook keeps
    // timing out after upgrade. Re-running install now heals the drift.
    const legacy = legacyHookCommand(spec.name);
    let existingHandler: HookHandler | undefined;
    for (const group of settings.hooks[spec.event]) {
      if ((group.matcher ?? '') !== (spec.matcher ?? '')) continue;
      const handler = group.hooks?.find((h) => h.command === spec.command);
      if (handler) {
        existingHandler = handler;
        break;
      }
    }
    // No current handler: an older installer's one becomes it, in place (matcher and position kept).
    let rewritten = false;
    if (!existingHandler) {
      for (const group of settings.hooks[spec.event]) {
        if ((group.matcher ?? '') !== (spec.matcher ?? '')) continue;
        const handler = group.hooks?.find((h) => h.command === legacy);
        if (handler) {
          handler.command = spec.command;
          existingHandler = handler;
          rewritten = true;
          break;
        }
      }
    }
    // Any other copy of this hook under the same matcher (a legacy line an older installer added
    // beside the current one) would run the event a second time: drop it.
    let pruned = false;
    for (const group of settings.hooks[spec.event]) {
      if ((group.matcher ?? '') !== (spec.matcher ?? '') || !Array.isArray(group.hooks)) continue;
      const before = group.hooks.length;
      group.hooks = group.hooks.filter((h) => h === existingHandler || (h.command !== legacy && h.command !== spec.command));
      if (group.hooks.length !== before) pruned = true;
    }
    if (pruned) {
      settings.hooks[spec.event] = settings.hooks[spec.event].filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    }
    if (!existingHandler) {
      const group: MatcherGroup = {
        hooks: [{ type: 'command', command: spec.command, timeout: spec.timeout }],
      };
      if (spec.matcher) group.matcher = spec.matcher;
      settings.hooks[spec.event].push(group);
      result.added.push(spec.event);
    } else if (existingHandler.timeout !== spec.timeout || rewritten || pruned) {
      existingHandler.timeout = spec.timeout;
      result.updated.push(spec.event);
    }
  }

  // App data (plan-veri K3): an instruction file inside `_dream_context/apps/` is data, never
  // loaded into a session. Claude Code reads `claudeMdExcludes` (picomatch on absolute paths).
  const excludes = Array.isArray(settings.claudeMdExcludes) ? (settings.claudeMdExcludes as unknown[]).filter((e): e is string => typeof e === 'string') : [];
  if (!excludes.includes(APP_DATA_CLAUDE_MD_EXCLUDE)) settings.claudeMdExcludes = [...excludes, APP_DATA_CLAUDE_MD_EXCLUDE];

  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return result;
}

/** The `claudeMdExcludes` entry that keeps app data's CLAUDE.md files out of every session. */
export const APP_DATA_CLAUDE_MD_EXCLUDE = '**/_dream_context/apps/**';

import { findPackageDir, platformSkillRoot, AGENT_CORE_SKILL } from '../../lib/catalog.js';
import { readFrontmatter } from '../../lib/frontmatter.js';
import { isCustomizedAgent } from '../../lib/sleep-specialist-frontmatter.js';
import { DRAW_SKILL, GUARDED_SKILLS, guardedFileSha, installGuardedSpec, type GuardedInstallResult } from '../../lib/core-guarded-skill.js';
import { ADOPTED_AGENT_SHAS } from '../../lib/core-guarded-skill/adopted-agents.js';
import { retireExcalidraw } from '../../lib/retired-packs.js';
import { RETIRED_CORE_AGENT_SHAS } from '../../lib/retired-packs/stopped.js';
import { installAgentForPlatform } from '../../lib/install-agents.js';

// ─── File Resolution ────────────────────────────────────────────────────────
import { fileURLToPath } from 'node:url';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

function findPackageFile(subdir: string, filename: string): string | null {
  const candidates = [
    join(__dirname, '..', '..', '..', subdir, filename),
    join(__dirname, '..', '..', subdir, filename),
    join(__dirname, '..', subdir, filename),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

// ─── Manifest Helpers ───────────────────────────────────────────────────────

export function getOrCreateManifest(projectRoot: string): Manifest {
  const existing = readManifest(projectRoot);
  if (existing) return existing;
  return emptyManifest();
}

function recordIfManifest(
  manifest: Manifest | undefined,
  relPath: string,
  kind: ManagedFileKind,
  opts?: { baselineSha?: string },
): void {
  if (!manifest) return;
  recordFile(manifest, relPath, dreamcontextVersion(), kind, opts);
}

/**
 * Core agents dreamcontext once shipped and has retired. The package no longer
 * carries them, so nothing reinstalls them, but installers never prune: a project
 * upgraded from an older release would keep the file (and keep offering the agent)
 * forever. `sleep-federation` retired 2026-09-30: federation reads peers live at
 * recall time, so there is nothing for a sleep specialist to drain or distribute.
 * `review-coordinator` retired 2026-05-26 (the main agent synthesizes a multi-review itself) but
 * was never pruned: it still sat in upgraded projects' agent listing (audit IN-16, 2026-11-12).
 */
export const RETIRED_CORE_AGENTS = ['sleep-federation', 'review-coordinator'] as const;

/**
 * Delete the installed copy of every retired core agent that is still exactly
 * what dreamcontext wrote. Runs from every install path (setup, install-skill,
 * update), which is why it exists next to the generic stale-file prune: that one
 * only runs in `update`, skips a first run, and cannot see a legacy project whose
 * manifest never listed the file.
 *
 * Refuses rather than guesses: a symlink is never followed, a file whose
 * frontmatter `name` is not the retired agent is not ours, and a customized copy
 * (its content no longer matches the baseline recorded at install) is someone's
 * work, left for the generic prune to offer. The baseline comes from the manifest
 * ON DISK: during `update` the in-memory manifest is the fresh one being built,
 * while the file still holds the previous install's record.
 */
export function pruneRetiredCoreAgents(projectRoot: string, manifest?: Manifest): string[] {
  const notes: string[] = [];
  const recorded = readManifest(projectRoot);
  for (const name of RETIRED_CORE_AGENTS) {
    const rel = `.claude/agents/${name}.md`;
    const abs = join(projectRoot, rel);
    let isSymlink: boolean;
    try {
      isSymlink = lstatSync(abs).isSymbolicLink();
    } catch {
      continue; // not installed
    }
    if (isSymlink) {
      notes.push(chalk.dim(`Left ${rel} alone: it is a symlink, and the retired ${name} agent is never followed through one.`));
      continue;
    }
    let content: string;
    let declaredName: unknown;
    try {
      content = readFileSync(abs, 'utf-8');
      declaredName = readFrontmatter(abs).data.name;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      notes.push(chalk.dim(`Left ${rel} alone: could not read it (${msg}).`));
      continue;
    }
    if (declaredName !== name) continue; // same file name, not our agent
    // With no recorded baseline, an agent that has a shipped-hash table must match a version we
    // shipped: a pack copy was never recorded as `agent`, so its bytes are the only proof it is ours.
    const baseline = recorded?.files[rel]?.baselineSha;
    const shipped = RETIRED_CORE_AGENT_SHAS[`${name}.md`];
    const edited = baseline || !shipped
      ? isCustomizedAgent(content, baseline)
      : !shipped.includes(guardedFileSha(Buffer.from(content, 'utf-8')));
    if (edited) {
      notes.push(chalk.dim(`Kept ${rel} because it was edited. The ${name} agent is retired and never dispatched; \`dreamcontext update\` may still list it as a stale file to remove.`));
      continue;
    }
    rmSync(abs, { force: true });
    if (manifest) delete manifest.files[rel];
    notes.push(`Removed the retired ${name} agent (${rel}); dreamcontext no longer ships it.`);
  }
  return notes;
}

/**
 * An agent that shipped in an optional pack until 2026-11-11 and ships from `agents/` since
 * (reviewer, review-*, goal-*, council-*) now lands in every project, including ones that never
 * installed the pack and may hold their own file by that name. Written over only when it is ours:
 * the manifest on disk records it (`agent`, or `pack-agent` from the pack), or its bytes are a
 * version we shipped (a project with no manifest: a fresh clone, a second Mac). Anything else is
 * someone's own agent: left as it is, untracked, with one note. Returns that note, or null to write.
 */
export function adoptedAgentRefusal(projectRoot: string, file: string, recorded: Manifest | null): string | null {
  const shipped = ADOPTED_AGENT_SHAS[file];
  if (!shipped) return null;
  const rel = `.claude/agents/${file}`;
  const abs = join(projectRoot, rel);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return null; // not there: install it
  }
  if (st.isSymbolicLink() || !st.isFile()) return `Left ${rel} alone: it is a symlink, never written through.`;
  const entry = recorded?.files[rel];
  if (entry && entry.version !== PRE_MANIFEST_VERSION && entry.kind === 'pack-agent' && entry.baselineSha) {
    // A pack copy the user edited stays theirs, as the pack refresh always kept it.
    try {
      if (isCustomizedAgent(readFileSync(abs, 'utf-8'), entry.baselineSha)) return `Kept your edited ${rel}; dreamcontext's copy is not written over it.`;
    } catch {
      return `Left ${rel} alone: it could not be read.`;
    }
    return null;
  }
  if (entry && entry.version !== PRE_MANIFEST_VERSION && (entry.kind === 'agent' || entry.kind === 'pack-agent')) return null;
  try {
    if (shipped.includes(guardedFileSha(readFileSync(abs)))) return null;
  } catch {
    return `Left ${rel} alone: it could not be read.`;
  }
  return `Left ${rel} alone: dreamcontext did not write it, and it now ships an agent by that name. Rename yours to get dreamcontext's.`;
}

export async function installCoreForPlatform(
  platform: PlatformId,
  projectRoot: string,
  manifest?: Manifest,
): Promise<{ installed: string[]; notes: string[]; draw: { skillRootRel: string; result: GuardedInstallResult } | null }> {
  const installed: string[] = [];
  const notes: string[] = [];
  let drawInstall: { skillRootRel: string; result: GuardedInstallResult } | null = null;

  const skillSource = findPackageFile('skill', 'SKILL.md');
  if (!skillSource) {
    throw new Error('SKILL.md not found in package. Try reinstalling dreamcontext.');
  }
  // The foundational core skills below are each "non-fatal if absent", but `update` treats whatever
  // this install did not record as retired and prunes it. A package missing one of these folders
  // would therefore delete the project's copy, so a partial package fails here instead.
  const missingCore = ['skill-initializer', 'skill-curator', 'skill-sync', 'skill-deep-research', 'skill-patterns', ...GUARDED_SKILLS.map((g) => g.source)]
    .filter((dir) => !findPackageFile(dir, 'SKILL.md'));
  if (missingCore.length > 0) {
    throw new Error(`${missingCore.join(', ')} not found in package. Try reinstalling dreamcontext.`);
  }
  // Checked here, before anything is written, for the same reason (see the agents loop below):
  // a throw after the writes would leave files on disk that the saved manifest does not list.
  const agentsSourceDir = findPackageDir('agents');
  if (!agentsSourceDir) {
    throw new Error('agents/ not found in package. Try reinstalling dreamcontext.');
  }

  if (manifest) recordPlatform(manifest, platform);

  const skillRoot = platformSkillRoot(projectRoot, platform);
  const skillDestDir = join(skillRoot, 'dreamcontext');
  const skillRootRel = relPosix(projectRoot, skillRoot);
  mkdirSync(skillDestDir, { recursive: true });
  writeFileSync(join(skillDestDir, 'SKILL.md'), readFileSync(skillSource, 'utf-8'), 'utf-8');
  const coreSkillRel = `${skillRootRel}/dreamcontext/SKILL.md`;
  recordIfManifest(manifest, coreSkillRel, 'core');
  installed.push(platformPrefixed(platform, coreSkillRel));

  // Copy the skill's references/ directory (progressive-disclosure docs the
  // agent Reads on demand). The skill is a folder, not a lone SKILL.md — the
  // references carry the full CLI surface, ClickUp/dashboard/federation
  // integrations, and the deep sleep/task/knowledge protocols. Without these,
  // the always-loaded core only NAMES capabilities; the references are where
  // their depth lives. Each is recorded as 'core' so `update` refreshes (and
  // never prunes) them alongside SKILL.md.
  const refsSourceDir = join(dirname(skillSource), 'references');
  if (existsSync(refsSourceDir)) {
    const refsDestDir = join(skillDestDir, 'references');
    cpSync(refsSourceDir, refsDestDir, { recursive: true });
    const refFiles = readdirSync(refsSourceDir).filter((f) => f.endsWith('.md'));
    for (const rf of refFiles) {
      const refRel = `${skillRootRel}/dreamcontext/references/${rf}`;
      recordIfManifest(manifest, refRel, 'core');
    }
    if (refFiles.length > 0) {
      installed.push(platformPrefixed(platform, `${skillRootRel}/dreamcontext/references/ ${chalk.dim(`(${refFiles.length} reference${refFiles.length === 1 ? '' : 's'})`)}`));
    }
  }

  // Copy the `initializer` core skill (the interactive, sub-agent-driven brain
  // bootstrap orchestrator). It is foundational, not an optional pack: every
  // project that lacks/under-populates a brain needs it, and the dreamcontext
  // core skill directs the agent to invoke it. Shipped at repo root in
  // `skill-initializer/` (package.json `files`), mirroring how the dreamcontext
  // skill ships from `skill/`. Recorded 'core' so `update` refreshes it.
  // Non-fatal if absent (older/partial packages still install the rest).
  const initSkillSource = findPackageFile('skill-initializer', 'SKILL.md');
  if (initSkillSource) {
    const initDestDir = join(skillRoot, 'initializer');
    mkdirSync(initDestDir, { recursive: true });
    writeFileSync(join(initDestDir, 'SKILL.md'), readFileSync(initSkillSource, 'utf-8'), 'utf-8');
    const initSkillRel = `${skillRootRel}/initializer/SKILL.md`;
    recordIfManifest(manifest, initSkillRel, 'core');
    installed.push(platformPrefixed(platform, initSkillRel));
  }

  // Copy the `curator` core skill (the interactive, sub-agent-driven brain
  // REFACTOR orchestrator). Like the initializer it is foundational, not an
  // optional pack: every maturing brain accretes drift that sleep won't re-order
  // (duplicate knowledge, topics living as both feature and knowledge, stale
  // statuses, off-vocab tags), and the dreamcontext core skill directs the agent
  // to invoke it. Shipped at repo root in `skill-curator/` (package.json
  // `files`), mirroring how the dreamcontext + initializer skills ship. Recorded
  // 'core' so `update` refreshes it. Non-fatal if absent (older/partial packages
  // still install the rest).
  const curatorSkillSource = findPackageFile('skill-curator', 'SKILL.md');
  if (curatorSkillSource) {
    const curatorDestDir = join(skillRoot, 'curator');
    mkdirSync(curatorDestDir, { recursive: true });
    writeFileSync(join(curatorDestDir, 'SKILL.md'), readFileSync(curatorSkillSource, 'utf-8'), 'utf-8');
    const curatorSkillRel = `${skillRootRel}/curator/SKILL.md`;
    recordIfManifest(manifest, curatorSkillRel, 'core');
    installed.push(platformPrefixed(platform, curatorSkillRel));
  }

  // Copy the `dream-sync` core skill (the manual brain-repo sync loop:
  // defer/resume/resolve/continue) — github-cloud-collaboration-brain-repo-sync.
  // Foundational, not an optional pack: any project with a `separate` brain
  // repo needs it to reconcile agent-class conflicts. Shipped at repo root in
  // `skill-sync/` (package.json `files`), mirroring the curator/initializer
  // pattern. Recorded 'core' so `update` refreshes it. Non-fatal if absent
  // (older/partial packages still install the rest).
  const dreamSyncSkillSource = findPackageFile('skill-sync', 'SKILL.md');
  if (dreamSyncSkillSource) {
    const dreamSyncDestDir = join(skillRoot, 'dream-sync');
    mkdirSync(dreamSyncDestDir, { recursive: true });
    writeFileSync(join(dreamSyncDestDir, 'SKILL.md'), readFileSync(dreamSyncSkillSource, 'utf-8'), 'utf-8');
    const dreamSyncSkillRel = `${skillRootRel}/dream-sync/SKILL.md`;
    recordIfManifest(manifest, dreamSyncSkillRel, 'core');
    installed.push(platformPrefixed(platform, dreamSyncSkillRel));

    const dreamSyncRefsSourceDir = join(dirname(dreamSyncSkillSource), 'references');
    if (existsSync(dreamSyncRefsSourceDir)) {
      const dreamSyncRefsDestDir = join(dreamSyncDestDir, 'references');
      cpSync(dreamSyncRefsSourceDir, dreamSyncRefsDestDir, { recursive: true });
      const dreamSyncRefFiles = readdirSync(dreamSyncRefsSourceDir).filter((f) => f.endsWith('.md'));
      for (const rf of dreamSyncRefFiles) {
        recordIfManifest(manifest, `${skillRootRel}/dream-sync/references/${rf}`, 'core');
      }
    }
  }

  // Copy the `apps` core skill (dreamcontext Apps: `/apps` builds and drives project-owned local
  // web apps, dreamcontext-apps plan r19). Shipped at repo root in `skill-apps/` (package.json
  // `files`); the app template stays in the package (`apps new` reads it from there), only the
  // skill and its references are installed. Recorded 'core' so `update` refreshes it.
  const appsSkillSource = findPackageFile('skill-apps', 'SKILL.md');
  if (appsSkillSource) {
    const appsDestDir = join(skillRoot, 'apps');
    mkdirSync(appsDestDir, { recursive: true });
    writeFileSync(join(appsDestDir, 'SKILL.md'), readFileSync(appsSkillSource, 'utf-8'), 'utf-8');
    const appsSkillRel = `${skillRootRel}/apps/SKILL.md`;
    recordIfManifest(manifest, appsSkillRel, 'core');
    installed.push(platformPrefixed(platform, appsSkillRel));
    const appsRefsSourceDir = join(dirname(appsSkillSource), 'references');
    if (existsSync(appsRefsSourceDir)) {
      cpSync(appsRefsSourceDir, join(appsDestDir, 'references'), { recursive: true });
      for (const rf of readdirSync(appsRefsSourceDir).filter((f) => f.endsWith('.md'))) {
        recordIfManifest(manifest, `${skillRootRel}/apps/references/${rf}`, 'core');
      }
    }
  }

  // The guarded core skills: `design` (universal UI rules, an optional pack until 2026-11-04),
  // `draw` (Excalidraw files and whiteboards, the excalidraw pack until 2026-11-08), and `council`,
  // `multi-review`, `goal-skill`, `video-watching` (optional packs until 2026-11-11). Unlike the
  // copies above they honour edits: a file changed since we wrote it is kept and reported, never
  // overwritten (see core-guarded-skill.ts). Shipped from `skill-<name>/`.
  for (const spec of GUARDED_SKILLS) {
    const { name } = spec;
    const skillMd = findPackageFile(spec.source, 'SKILL.md');
    if (!skillMd) continue;
    const res = installGuardedSpec(spec, dirname(skillMd), projectRoot, skillRootRel, readManifest(projectRoot));
    if (name === DRAW_SKILL) drawInstall = { skillRootRel, result: res };
    for (const w of res.written) recordIfManifest(manifest, w.rel, 'core', { baselineSha: w.baselineSha });
    for (const k of res.kept) {
      // Still tracked, so `update` never offers the owner's own copy for deletion.
      if (k.reason !== 'not-ours') recordIfManifest(manifest, k.rel, 'core', k.baselineSha ? { baselineSha: k.baselineSha } : undefined);
      notes.push(chalk.dim(k.reason === 'edited'
        ? `Kept ${k.rel}: it is edited (not a version dreamcontext shipped). Delete it and run \`dreamcontext update\` to take the shipped one.`
        : k.reason === 'symlink'
          ? `Left ${k.rel} alone: it or a folder above it is a symlink, never written through.`
          : `Left ${k.rel} alone: it was not written by dreamcontext.`));
    }
    if (res.written.length > 0) {
      installed.push(platformPrefixed(platform, `${skillRootRel}/${name}/ ${chalk.dim(`(${res.written.length} file${res.written.length === 1 ? '' : 's'})`)}`));
    }
  }

  // Copy the `dreamcontext-deep-research` core skill (the iterative, sub-agent-driven
  // corpus-synthesis orchestrator — the heavy counterpart to dreamcontext-explore).
  // Like the initializer and curator it is foundational, not an optional pack: any
  // large or multi-project/federated brain eventually hits a question one explore pass
  // can't synthesize, and the dreamcontext core skill directs the agent to escalate to
  // it. Shipped at repo root in `skill-deep-research/` (package.json `files`), mirroring
  // how the dreamcontext + initializer + curator skills ship. It reuses the existing
  // `dreamcontext-explore` agent as its searcher/verifier (no new sub-agent file).
  // Recorded 'core' so `update` refreshes it. Non-fatal if absent (older/partial
  // packages still install the rest).
  const deepResearchSkillSource = findPackageFile('skill-deep-research', 'SKILL.md');
  if (deepResearchSkillSource) {
    const deepResearchDestDir = join(skillRoot, 'dreamcontext-deep-research');
    mkdirSync(deepResearchDestDir, { recursive: true });
    writeFileSync(join(deepResearchDestDir, 'SKILL.md'), readFileSync(deepResearchSkillSource, 'utf-8'), 'utf-8');
    const deepResearchSkillRel = `${skillRootRel}/dreamcontext-deep-research/SKILL.md`;
    recordIfManifest(manifest, deepResearchSkillRel, 'core');
    installed.push(platformPrefixed(platform, deepResearchSkillRel));
  }

  // RETIRED: the `task-manager` core skill. Tasks are documents you write and hand to a
  // delegate agent — there is no AI inside the task view any more, so a task-scoped curate
  // skill has no surface that opens it. Installers never prune, so a project upgraded from
  // ≤0.23.x would keep `<skills>/task-manager/` on disk forever and keep offering
  // `/task-manager` in every session. Delete it here (and drop its manifest entry) so the
  // upgrade actually removes the feature instead of stranding it. Safe: the directory only
  // ever held a file dreamcontext itself wrote.
  const retiredTaskManagerDir = join(skillRoot, 'task-manager');
  if (existsSync(retiredTaskManagerDir)) {
    rmSync(retiredTaskManagerDir, { recursive: true, force: true });
    if (manifest) delete manifest.files[`${skillRootRel}/task-manager/SKILL.md`];
    notes.push(`Removed the retired ${skillRootRel}/task-manager skill (tasks no longer run an agent).`);
  }

  // Copy the `patterns` core skill (the drift-free browse/load bridge to
  // `_dream_context/knowledge/patterns/`): "/patterns" lists the project's
  // documented patterns, "/patterns <slug>" loads one. Foundational, not an
  // optional pack: patterns are plain knowledge files with no "/" surface of
  // their own, so without this skill they are invisible to slash-command
  // discovery — the exact gap that produced ad-hoc project-local copies. The
  // skill carries NO pattern content (it reads the live files), so a project
  // without `knowledge/patterns/` degrades gracefully to "no patterns yet".
  // Shipped at repo root in `skill-patterns/` (package.json `files`),
  // mirroring the curator/dream-sync pattern. Recorded 'core' so `update`
  // refreshes it. Non-fatal if absent (older/partial packages still install
  // the rest).
  const patternsSkillSource = findPackageFile('skill-patterns', 'SKILL.md');
  if (patternsSkillSource) {
    const patternsDestDir = join(skillRoot, 'patterns');
    mkdirSync(patternsDestDir, { recursive: true });
    writeFileSync(join(patternsDestDir, 'SKILL.md'), readFileSync(patternsSkillSource, 'utf-8'), 'utf-8');
    const patternsSkillRel = `${skillRootRel}/patterns/SKILL.md`;
    recordIfManifest(manifest, patternsSkillRel, 'core');
    installed.push(platformPrefixed(platform, patternsSkillRel));
  }

  // Copy the `dreamcontext-agent-core` skill: the small operating minimum that
  // dreamcontext's own sub-agents preload (`skills: [dreamcontext-agent-core]`)
  // instead of the full skill. Foundational, not a pack: every shipped agent that
  // names it would otherwise start without it. Shipped at repo root in
  // `skill-agent-core/` (package.json `files`); recorded 'core' so `update`
  // refreshes it. Non-fatal if absent (older/partial packages still install).
  const agentCoreSkillSource = findPackageFile('skill-agent-core', 'SKILL.md');
  if (agentCoreSkillSource) {
    const agentCoreDestDir = join(skillRoot, AGENT_CORE_SKILL);
    mkdirSync(agentCoreDestDir, { recursive: true });
    writeFileSync(join(agentCoreDestDir, 'SKILL.md'), readFileSync(agentCoreSkillSource, 'utf-8'), 'utf-8');
    const agentCoreSkillRel = `${skillRootRel}/${AGENT_CORE_SKILL}/SKILL.md`;
    recordIfManifest(manifest, agentCoreSkillRel, 'core');
    installed.push(platformPrefixed(platform, agentCoreSkillRel));
  }

  // Required, like SKILL.md above. A missing `agents/` used to be skipped silently, and `update`
  // reads "in the old manifest, not in this install" as "retired" and DELETES the project's
  // core agents (reproduced with the desktop app's resources layout, which shipped no `agents/`).
  const agentFiles = readdirSync(agentsSourceDir).filter((f) => f.endsWith('.md'));
  const recordedAgents = readManifest(projectRoot);
  for (const file of agentFiles) {
    const source = join(agentsSourceDir, file);
    const refusal = adoptedAgentRefusal(projectRoot, file, recordedAgents);
    if (refusal) {
      notes.push(chalk.dim(refusal));
      // A file we recorded stays tracked as it was, so no later prune reads it as ours to remove.
      const kept = recordedAgents?.files[`.claude/agents/${file}`];
      if (manifest && kept) manifest.files[`.claude/agents/${file}`] = kept;
      continue;
    }
    const agent = installAgentForPlatform(platform, projectRoot, source);
    recordIfManifest(manifest, agent.relPath, 'agent', { baselineSha: agent.baselineSha });
    installed.push(platformPrefixed(platform, agent.relPath));
  }

  notes.push(...pruneRetiredCoreAgents(projectRoot, manifest));

  // Per-peer envoy agents. Unlike everything above these are GENERATED, not
  // copied from the package: one per active federation connection, carrying that
  // peer's identity. Not recorded in the manifest — `syncPeerAgents` owns the
  // `peer-*.md` namespace and reconciles it on every connect/disconnect/sleep,
  // so an uninstall manifest listing today's peers would go stale immediately.
  try {
    const peerAgents = syncPeerAgents(join(projectRoot, '_dream_context'));
    for (const file of peerAgents.written) {
      installed.push(platformPrefixed(platform, `.claude/agents/${file} ${chalk.dim('(peer envoy)')}`));
    }
  } catch {
    // Best-effort: a missing envoy must never fail an install.
  }

  // Per-pattern "/" entries. GENERATED like the peer envoys above, not copied
  // from the package: they are derived from THIS vault's knowledge/patterns/,
  // so there is nothing to ship and nothing stable to record in the manifest.
  // `syncPatternShims` owns its own namespace via a marker inside each file and
  // reconciles the whole set here, so a pattern added, renamed, or deleted since
  // the last run is reflected on the next setup/update.
  try {
    const shims = syncPatternShims(projectRoot, join(projectRoot, '_dream_context'));
    if (shims.written.length > 0 || shims.removed.length > 0) {
      installed.push(platformPrefixed(
        platform,
        `.claude/commands/ ${chalk.dim(`(${shims.written.length} pattern "/" entr${shims.written.length === 1 ? 'y' : 'ies'})`)}`,
      ));
    }
  } catch {
    // Best-effort: a malformed pattern must never fail an install.
  }

  {
    const hookResult = ensureClaudeHooks(projectRoot);
    recordIfManifest(manifest, '.claude/settings.json', 'hook');
    if (hookResult.added.length > 0) {
      installed.push(platformPrefixed(platform, `.claude/settings.json ${chalk.dim(`(${hookResult.added.join(' + ')} hooks)`)}`));
    }
    if (hookResult.updated.length > 0) {
      const updatedEvents = [...new Set(hookResult.updated)].join(' + ');
      notes.push(platformPrefixed(platform, `${chalk.yellow('↑')} ${chalk.dim(`Updated hooks (${updatedEvents})`)}`));
    }
    if (hookResult.migrated) {
      notes.push(platformPrefixed(platform, `${chalk.yellow('↑')} ${chalk.dim('Migrated old snapshot hook -> session-start hook')}`));
    }
    if (hookResult.added.length === 0 && hookResult.updated.length === 0 && !hookResult.migrated) {
      notes.push(platformPrefixed(platform, chalk.dim('Hooks already present — skipped')));
    }

    // dreamcontext owns project memory: disable Claude's native auto-memory unless
    // the user opted to keep it (config.disableNativeMemory === false). Config is
    // absent on first install → default true (disable). Idempotent.
    const disableNativeMemory = readSetupConfig(projectRoot)?.disableNativeMemory ?? true;
    const memoryChanged = applyClaudeAutoMemory(projectRoot, disableNativeMemory);
    if (memoryChanged) {
      notes.push(platformPrefixed(platform, disableNativeMemory
        ? chalk.dim('Disabled Claude native auto-memory (autoMemoryEnabled:false) — dreamcontext owns memory')
        : chalk.dim('Enabled Claude native auto-memory (autoMemoryEnabled:true) per config')));
    }
  }

  return { installed, notes, draw: drawInstall };
}

// ─── Command Registration ───────────────────────────────────────────────────

/**
 * When set, the install-skill / install-instructions / install-claude-md /
 * init commands suppress their deprecation hint. The `setup` command sets
 * this so the chained calls don't nag.
 */
export const SETUP_INTERNAL_ENV = 'DREAMCONTEXT_SETUP_INTERNAL';

export function printDeprecationHint(commandName: string): void {
  if (process.env[SETUP_INTERNAL_ENV] === '1') return;
  console.log();
  console.log(
    chalk.magentaBright('ℹ')
      + '  Tip: '
      + chalk.bold('dreamcontext setup')
      + ' runs init + install-skill + install-instructions in one step.'
      + ` The standalone ${chalk.dim(commandName)} command will be removed in v0.5.`,
  );
}

export function registerInstallSkillCommand(program: Command): void {
  program
    .command('install-skill')
    .description('Install the dreamcontext skills, agents and hooks for selected platforms')
    .option('--platforms <list>', `Comma-separated platforms: ${formatSupportedPlatforms()}`)
    // Skill packs are gone (2026-11-11): every skill dreamcontext ships is installed with the core.
    // The old flags still parse, so a script that passes them hears why instead of "unknown option".
    .addOption(new Option('--packs [names...]').hideHelp())
    .addOption(new Option('--skill <name>').hideHelp())
    .addOption(new Option('--list').hideHelp())
    .action(async (opts: { platforms?: string; packs?: boolean | string[]; skill?: string; list?: boolean }) => {
      try {
        const projectRoot = process.cwd();
        if (opts.packs !== undefined || opts.skill || opts.list) {
          error(
            'Skill packs no longer exist: every skill dreamcontext ships (council, multi-review, goal-skill, video-watching, design, draw, …) is installed with the core.',
            'Run `dreamcontext install-skill` (or `dreamcontext update` in an installed project).',
          );
          process.exitCode = 1;
          return;
        }
        const platforms = await resolvePlatforms(projectRoot, opts.platforms);

        // Default: install core dreamcontext skill + agents + hooks for selected platforms
        const manifest = getOrCreateManifest(projectRoot);
        const installed: string[] = [];
        const notes: string[] = [];

        for (const platform of platforms) {
          const result = await installCoreForPlatform(platform, projectRoot, manifest);
          installed.push(...result.installed);
          notes.push(...result.notes);
          // The excalidraw pack is the `draw` skill now: retire its folder once, after the core
          // install proved draw is on disk. `manifest` is both the old and the new record here.
          if (result.draw) {
            const retired = retireExcalidraw(projectRoot, result.draw.skillRootRel, result.draw.result, manifest, manifest);
            notes.push(...retired.notes);
          }
        }

        writeManifest(projectRoot, manifest);
        // Migrate BEFORE stamping setupVersion. `update` tells a platform-less
        // vault to run this command first, so stamping here without migrating
        // silently discarded every pending migration (see migrate-and-stamp.ts).
        migrateThenStampSetupVersion(projectRoot, { platforms });

        console.log();
        console.log(miniBox([
          chalk.green.bold(`✓ Integration installed for ${platforms.map(platformLabel).join(', ')}!`),
          '',
          ...installed.map((f) => `  ${chalk.green('✓')} ${chalk.magentaBright(f)}`),
          ...(notes.length > 0 ? ['', ...notes.map((n) => `  ${n}`)] : []),
        ], { color: 'green' }));
        console.log();
        info(`Platforms active for this install: ${chalk.dim(platforms.join(', '))}`);

        printDeprecationHint('install-skill');
      } catch (err: any) {
        if (err.name === 'ExitPromptError') {
          // User pressed Ctrl+C during interactive prompt
          console.log();
          info('Cancelled.');
          return;
        }
        error(err.message);
      }
    });
}
