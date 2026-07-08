import { Command } from 'commander';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync, execSync, spawn } from 'node:child_process';
import { get as httpGet, request as httpRequest } from 'node:http';
import { dirname, resolve, join, extname, basename, relative } from 'node:path';
import { resolveContextRoot } from '../../lib/context-path.js';
import type { SleepState, Bookmark } from './sleep.js';
import { readSleepState, writeSleepState, bumpKnowledgeAccess, resolveRecallMode } from './sleep.js';
import {
  upsertSessionOnStop,
  appendCompactionRecord,
  inspectSleepLock,
  DEBT_DROWSY,
  DEBT_SLEEPY,
  DEBT_MUST_SLEEP,
  RHYTHM_SESSIONS,
  type StopUpsertInput,
} from '../../lib/sleep-consolidation.js';
import { DECISION_RE, CORRECTION_RE } from '../../lib/salience.js';
import { distillTranscript } from './transcript.js';
import { buildDigest, writeDigest, digestExists, digestIsPartial } from '../../lib/session-digest.js';
import { detectSalience } from '../../lib/salience.js';
import { generateId } from '../../lib/id.js';
import { generateSnapshot, generateSubagentBriefing } from './snapshot.js';
import { listStaleRecs } from '../../lib/marketing/snapshot.js';
import { isMarketingEnvPath } from '../../lib/marketing/path-guards.js';
import { buildCorpus, bm25Search, loadSkillDocs, type RecallHit } from '../../lib/recall.js';
import { hybridSearch, hybridReady } from '../../lib/embeddings/hybrid.js';
import {
  crossVaultRecall,
  resolveConnectedVaults,
  currentVaultTarget,
  type FederatedHit,
} from '../../lib/federation-recall.js';
import { haikuRecall } from '../../lib/recall-query-extractor.js';
import { ensureTaxonomyFile } from '../../lib/taxonomy.js';
import { readVersionCache, isCacheFresh, refreshVersionCache, maybeAutoUpgrade } from '../../lib/version-check.js';
import { dreamcontextVersion } from '../../lib/manifest.js';
import { maybeTriggerAppUpdate, readAppManifest } from './app.js';
import { runAssetDriftRefresh } from './asset-drift.js';
import { loadCatalog } from './install-skill.js';
import { detectSessionStartTrigger, detectPromptTrigger, renderOffer } from '../../lib/initializer-detect.js';
import { readSetupConfig, readBrainLocal } from '../../lib/setup-config.js';
import { resolveBrainSyncEnabled } from '../../lib/git-sync/brain-repo.js';
import {
  recordAgentSession, recordAgentFirstPrompt, readAgentSessionEntry, titleWorthyPrompt, UUID_RE,
} from '../../lib/agent-session-map.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50MB safety cap

// Skill-relevance threshold: lower than memory's 2.0 because alwaysApply skills
// are filtered out and the skill corpus is tiny/curated. Used only as a boolean
// "does any skill relate?" signal to decide whether to fire the context gate —
// the gate then tells the agent to review the FULL skill list itself.
const SKILL_SCORE_THRESHOLD = 1.0;

// ─── Stdin Reading ──────────────────────────────────────────────────────────

/**
 * Read JSON object from stdin (piped by Claude Code hooks).
 * Returns null if stdin is a TTY, empty, or invalid JSON.
 */
function readStdin(): Record<string, unknown> | null {
  if (process.stdin.isTTY) return null;
  try {
    const raw = readFileSync(0, 'utf-8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Transcript Analysis ────────────────────────────────────────────────────

/**
 * Result of analyzing a JSONL transcript file.
 */
export interface TranscriptAnalysis {
  changeCount: number;  // Write + Edit tool calls only
  toolCount: number;    // ALL tool calls (any tool name)
  taskSlugs: string[];  // task slugs extracted from tool calls and file paths
  // WS-DEBT substance signals — populated by a per-line JSON.parse pass so an
  // edit-free-but-information-dense session can still accrue debt:
  userTurns: number;        // count of user-role transcript records
  assistantChars: number;   // total chars across assistant text blocks (each capped)
  decisionMarkers: number;  // lines matching DECISION_RE / CORRECTION_RE
}

const ZERO_ANALYSIS: TranscriptAnalysis = {
  changeCount: 0, toolCount: 0, taskSlugs: [],
  userTurns: 0, assistantChars: 0, decisionMarkers: 0,
};

// Cap each assistant text block so one giant block cannot dominate assistantChars.
const MAX_TEXT_BLOCK_CHARS = 20000;

/**
 * Analyze a JSONL transcript file for tool usage.
 * Returns change count (Write/Edit), total tool count, and auto-detected task slugs.
 * Returns zeros on any error.
 */
export function analyzeTranscript(transcriptPath: string): TranscriptAnalysis {
  if (!existsSync(transcriptPath)) return ZERO_ANALYSIS;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0 || stat.size > MAX_TRANSCRIPT_BYTES) return ZERO_ANALYSIS;
    const content = readFileSync(transcriptPath, 'utf-8');
    const changeMatches = content.match(/"name"\s*:\s*"(?:Write|Edit)"/g);
    const toolMatches = content.match(/"name"\s*:\s*"[A-Za-z_]+"/g);

    // Extract task slugs from dreamcontext CLI commands and task file paths.
    // Only match within "command":"..." JSON values to avoid prose/explanation noise.
    const slugs = new Set<string>();
    for (const m of content.matchAll(/"command"\s*:\s*"[^"]*dreamcontext\s+tasks?\s+(?:log|insert|complete|create)\s+(?:\\?["'])?([a-z0-9][a-z0-9-]*)/g)) {
      slugs.add(m[1]);
    }
    // Match task file paths in "file_path":"..." JSON values
    for (const m of content.matchAll(/"file_path"\s*:\s*"[^"]*_dream_context\/state\/([a-z0-9][a-z0-9-]*)\.md"/g)) {
      slugs.add(m[1]);
    }

    // WS-DEBT substance signals — a per-line guarded JSON.parse pass over the
    // already-in-memory transcript (one pass, no extra file I/O; malformed lines
    // skipped). Raw regex over the flat string can't sum JSON-escaped multiline
    // text-block lengths, so we parse each JSONL record instead.
    let userTurns = 0;
    let assistantChars = 0;
    let decisionMarkers = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (DECISION_RE.test(trimmed) || CORRECTION_RE.test(trimmed)) {
        decisionMarkers++;
      }
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue; // not a JSON record (or partial) — skip
      }
      if (!rec || typeof rec !== 'object') continue;
      const role = recordRole(rec);
      if (role === 'user') {
        userTurns++;
      } else if (role === 'assistant') {
        assistantChars += sumAssistantTextChars(rec);
      }
    }

    return {
      changeCount: changeMatches ? changeMatches.length : 0,
      toolCount: toolMatches ? toolMatches.length : 0,
      taskSlugs: [...slugs],
      userTurns,
      assistantChars,
      decisionMarkers,
    };
  } catch {
    return ZERO_ANALYSIS;
  }
}

/** Extract the role of a transcript record, tolerating both flat and nested message shapes. */
function recordRole(rec: object): string | null {
  const r = rec as { role?: unknown; message?: { role?: unknown } };
  if (typeof r.role === 'string') return r.role;
  if (r.message && typeof r.message === 'object' && typeof r.message.role === 'string') {
    return r.message.role;
  }
  return null;
}

/** Sum the chars of every assistant `type:'text'` block, capping each block. */
function sumAssistantTextChars(rec: object): number {
  const r = rec as { message?: { content?: unknown }; content?: unknown };
  const content = (r.message && typeof r.message === 'object' ? r.message.content : undefined) ?? r.content;
  let total = 0;
  if (typeof content === 'string') {
    return Math.min(MAX_TEXT_BLOCK_CHARS, content.length);
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: unknown; text?: unknown };
        if (b.type === 'text' && typeof b.text === 'string') {
          total += Math.min(MAX_TEXT_BLOCK_CHARS, b.text.length);
        }
      }
    }
  }
  return total;
}

/**
 * Map substance signals to a bounded 0..3 debt score (WS-DEBT). +1 each for:
 * a chatty user (≥6 turns), dense assistant output (≥6000 chars), ≥1 decision/
 * correction marker, and ≥2 distinct task slugs touched. Capped at 3.
 *
 * rationale: per-session ceiling stays 3 (level thresholds live in
 * sleep-consolidation.ts: Alert 0–7 / Drowsy 8–13 / Sleepy 14–19 / Must Sleep 20+);
 * this only raises the FLOOR for edit-free-but-dense sessions that the
 * change/tool scorers under-count. Thresholds are first-guess and safe to
 * mis-calibrate because the call site composes them via max() (never lowers an
 * edit-heavy score).
 */
export function scoreFromSubstance(signals: {
  userTurns: number;
  assistantChars: number;
  decisionMarkers: number;
  taskSlugs: string[];
}): number {
  let pts = 0;
  if (signals.userTurns >= 6) pts++;
  if (signals.assistantChars >= 6000) pts++;
  if (signals.decisionMarkers >= 1) pts++;
  if (signals.taskSlugs.length >= 2) pts++;
  return Math.min(3, pts);
}

/**
 * Map a raw change count to a debt score (0-3).
 */
export function scoreFromChangeCount(count: number): number {
  if (count <= 0) return 0;
  if (count <= 3) return 1;
  if (count <= 8) return 2;
  return 3;
}

/**
 * Map a total tool count to a debt score (0-3).
 * Higher thresholds than change count because most tools are read-only.
 */
export function scoreFromToolCount(count: number): number {
  if (count <= 0) return 0;
  if (count <= 15) return 1;
  if (count <= 40) return 2;
  return 3;
}

// ─── Post-Edit Quality Checks ───────────────────────────────────────────────

const JS_TS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);
const MAX_WALK_LEVELS = 10;

const BIOME_CONFIGS = ['biome.json', 'biome.jsonc'];
const PRETTIER_CONFIGS = [
  '.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml',
  '.prettierrc.js', '.prettierrc.cjs', 'prettier.config.js', 'prettier.config.cjs',
];

export interface FormatterDetection {
  type: 'biome' | 'prettier';
  configPath: string;
  projectRoot: string;
}

export interface ProjectConfig {
  formatter: FormatterDetection | null;
  tsconfig: string | null;
}

/** Check if a file path has a JS/TS extension. */
export function isJsTsFile(filePath: string): boolean {
  return JS_TS_EXTENSIONS.has(extname(filePath).toLowerCase());
}

/** Walk up from filePath looking for Biome or Prettier config. Biome preferred. */
export function findFormatterConfig(filePath: string): FormatterDetection | null {
  return findProjectConfig(filePath).formatter;
}

/** Walk up from filePath looking for tsconfig.json. */
export function findTsconfig(filePath: string): string | null {
  return findProjectConfig(filePath).tsconfig;
}

/** Single walk-up pass to find formatter config and tsconfig.json. */
export function findProjectConfig(filePath: string): ProjectConfig {
  let dir = dirname(resolve(filePath));
  let formatter: FormatterDetection | null = null;
  let tsconfig: string | null = null;

  for (let i = 0; i <= MAX_WALK_LEVELS; i++) {
    // Check formatter configs (only if not yet found)
    if (!formatter) {
      for (const name of BIOME_CONFIGS) {
        if (existsSync(join(dir, name))) {
          formatter = { type: 'biome', configPath: join(dir, name), projectRoot: dir };
          break;
        }
      }
      if (!formatter) {
        for (const name of PRETTIER_CONFIGS) {
          if (existsSync(join(dir, name))) {
            formatter = { type: 'prettier', configPath: join(dir, name), projectRoot: dir };
            break;
          }
        }
      }
    }
    // Check tsconfig (only if not yet found)
    if (!tsconfig && existsSync(join(dir, 'tsconfig.json'))) {
      tsconfig = join(dir, 'tsconfig.json');
    }
    // Early exit if both found
    if (formatter && tsconfig) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { formatter, tsconfig };
}

/** Resolve a binary: prefer local node_modules/.bin, fall back to npx. */
function resolveLocalBin(binName: string, projectRoot: string): string | null {
  const localBin = join(projectRoot, 'node_modules', '.bin', binName);
  return existsSync(localBin) ? localBin : null;
}

/** Run detected formatter on a file. Returns success status and any error output. */
export function runFormatter(detection: FormatterDetection, filePath: string): { success: boolean; output?: string } {
  try {
    if (detection.type === 'biome') {
      const localBin = resolveLocalBin('biome', detection.projectRoot);
      if (localBin) {
        execFileSync(localBin, ['format', '--write', filePath], {
          cwd: detection.projectRoot, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        execFileSync('npx', ['@biomejs/biome', 'format', '--write', filePath], {
          cwd: detection.projectRoot, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    } else {
      const localBin = resolveLocalBin('prettier', detection.projectRoot);
      if (localBin) {
        execFileSync(localBin, ['--write', filePath], {
          cwd: detection.projectRoot, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
        });
      } else {
        execFileSync('npx', ['prettier', '--write', filePath], {
          cwd: detection.projectRoot, timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
    }
    return { success: true };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, output: msg };
  }
}

/** Run tsc --noEmit and return errors filtered to the specific file, or null if clean. */
export function runTscCheck(filePath: string): string | null {
  const tsconfig = findTsconfig(filePath);
  if (!tsconfig) return null;
  return runTscCheckWithConfig(filePath, tsconfig);
}

/** Run tsc --noEmit with a known tsconfig path. Returns errors filtered to the file, or null. */
function runTscCheckWithConfig(filePath: string, tsconfigPath: string): string | null {
  const projectRoot = dirname(tsconfigPath);
  let tscOutput: string;
  try {
    const localBin = resolveLocalBin('tsc', projectRoot);
    const args = ['--noEmit', '--pretty', 'false', '--incremental'];
    if (localBin) {
      execFileSync(localBin, args, {
        cwd: projectRoot, timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    } else {
      execFileSync('npx', ['tsc', ...args], {
        cwd: projectRoot, timeout: 30000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      });
    }
    return null; // clean compile
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'stdout' in err) {
      tscOutput = String((err as { stdout?: string }).stdout || '') + String((err as { stderr?: string }).stderr || '');
    } else {
      return null; // tsc not installed or other non-TS error
    }
  }

  if (!tscOutput.trim()) return null;

  // Filter to errors in the edited file only (absolute and relative path matching)
  const resolvedPath = resolve(filePath);
  const relativePath = relative(projectRoot, resolvedPath);

  const lines = tscOutput.split('\n');
  const relevantErrors: string[] = [];
  for (const line of lines) {
    if (line.includes(resolvedPath) || line.includes(relativePath)) {
      relevantErrors.push(line.trim());
    }
  }

  if (relevantErrors.length === 0) return null;
  return `TypeScript errors in ${basename(filePath)}:\n${relevantErrors.join('\n')}`;
}

// ─── Consolidation Directives ───────────────────────────────────────────────

export function getConsolidationDirective(state: SleepState): string | null {
  const { debt, bookmarks, sessions_since_last_sleep } = state;

  // If a consolidation is already in progress, suppress all directives to prevent
  // duplicate sleeps. A STALE lock (the owning sleep crashed before `sleep done`)
  // falls through so the brain still gets told to consolidate instead of being
  // silently wedged forever.
  const lock = inspectSleepLock(state, Date.now());
  if (lock.locked && !lock.stale) {
    if (debt >= DEBT_DROWSY) {
      return [
        `> Consolidation already in progress (started: ${lock.startedAt}). Do NOT dispatch another sleep agent.`,
        '',
      ].join('\n');
    }
    return null;
  }

  // Check for critical (★★★) bookmarks that need immediate consolidation
  const criticalBookmarks = bookmarks.filter(b => b.salience === 3);

  if (debt >= DEBT_MUST_SLEEP) {
    return [
      '>>> CONSOLIDATION REQUIRED <<<',
      '',
      `Sleep debt is ${debt} (threshold: ${DEBT_MUST_SLEEP}). Context files are stale and bloated.`,
      ...(criticalBookmarks.length > 0
        ? [`${criticalBookmarks.length} critical bookmark(s) awaiting consolidation.`]
        : []),
      'You MUST inform the user and consolidate NOW.',
      'Run sleep consolidation: follow SKILL.md "Sleep" flow — main agent does `sleep start`, then dispatches sleep-tasks/sleep-state (and sleep-product when signals warrant) in parallel, then `sleep done`.',
      'If the user has an urgent task, consolidate IMMEDIATELY after completing it.',
      '',
    ].join('\n');
  }
  if (criticalBookmarks.length > 0) {
    return [
      '>> CRITICAL BOOKMARKS NEED CONSOLIDATION <<',
      '',
      `${criticalBookmarks.length} critical (★★★) bookmark(s) tagged for consolidation:`,
      ...criticalBookmarks.slice(0, 3).map(b => `  - ${b.message}`),
      'These represent important decisions/constraints that should be consolidated into context files.',
      'Run sleep consolidation: follow SKILL.md "Sleep" flow — main agent does `sleep start`, then dispatches sleep-tasks/sleep-state (and sleep-product when signals warrant) in parallel, then `sleep done`.',
      '',
    ].join('\n');
  }
  if (debt >= DEBT_SLEEPY) {
    return [
      '>> CONSOLIDATION RECOMMENDED <<',
      '',
      `Sleep debt is ${debt}/${DEBT_MUST_SLEEP}. Context files are growing stale.`,
      'You MUST inform the user and recommend consolidation before starting new work.',
      'Run sleep consolidation: follow SKILL.md "Sleep" flow — main agent does `sleep start`, then dispatches sleep-tasks/sleep-state (and sleep-product when signals warrant) in parallel, then `sleep done`.',
      '',
    ].join('\n');
  }
  if (debt >= DEBT_DROWSY) {
    return [
      `> Sleep debt is ${debt}. After completing the current task, you MUST offer to consolidate.`,
      '',
    ].join('\n');
  }
  if (sessions_since_last_sleep >= RHYTHM_SESSIONS) {
    return [
      `> ${sessions_since_last_sleep} sessions since last consolidation. After completing the current task, offer to consolidate.`,
      '',
    ].join('\n');
  }
  return null;
}

/**
 * Pure one-line debt reminder for the UserPromptSubmit hook. Returns the line to
 * emit, or null to stay silent. Extracted from the full handler (which also does
 * recall injection, marketing nudge, version check, etc.) so the debt-threshold
 * behavior is unit-testable in isolation.
 *
 * - consolidation in progress: suppress unless debt >= DEBT_DROWSY (then a "do
 *   not dispatch another sleep" note).
 * - debt >= DEBT_MUST_SLEEP: CONSOLIDATION REQUIRED.
 * - critical (★★★) bookmark present: advisory regardless of debt.
 * - debt >= DEBT_SLEEPY: recommended. debt >= DEBT_DROWSY: offer after current task.
 * - else: null (silent).
 */
export function userPromptReminder(state: SleepState): string | null {
  const { debt, bookmarks } = state;

  const lock = inspectSleepLock(state, Date.now());
  if (lock.locked && !lock.stale) {
    if (debt >= DEBT_DROWSY) {
      return `Consolidation already in progress (started: ${lock.startedAt}). Do NOT dispatch another sleep agent.`;
    }
    return null;
  }

  const criticalBookmarks = bookmarks.filter(b => b.salience === 3);
  if (debt >= DEBT_MUST_SLEEP) {
    return `Sleep debt is ${debt}. CONSOLIDATION REQUIRED. Run sleep flow per SKILL.md (parallel specialist fan-out) NOW.`;
  }
  if (criticalBookmarks.length > 0) {
    return `${criticalBookmarks.length} critical bookmark(s) need consolidation. Run sleep flow per SKILL.md.`;
  }
  if (debt >= DEBT_SLEEPY) {
    return `Sleep debt is ${debt}. Consolidation recommended before starting new work.`;
  }
  if (debt >= DEBT_DROWSY) {
    return `Sleep debt is ${debt}. After completing the current task, offer to consolidate.`;
  }
  return null;
}

// ─── Dashboard Auto-Open ──────────────────────────────────────────────────────

const DEFAULT_DASHBOARD_PORT = 4173;

/** Resolve the dashboard port: env override (DREAMCONTEXT_DASHBOARD_PORT) or default 4173. */
export function resolveDashboardPort(): number {
  const raw = process.env.DREAMCONTEXT_DASHBOARD_PORT;
  if (raw) {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 0 && n < 65536) return n;
  }
  return DEFAULT_DASHBOARD_PORT;
}

export interface DashboardHealth {
  up: boolean;
  /** The running server's version, or null when unknown (pre-handshake server, parse failure). */
  version: string | null;
}

/**
 * Probe the dashboard's /api/health and read the running server's version.
 * A server that answers without a `version` field predates the version
 * handshake (< the tasks-token no-route fix) and reports version null.
 * Resolves { up: false } on connection error or timeout — never throws.
 */
export function fetchDashboardHealth(port: number, timeoutMs = 700): Promise<DashboardHealth> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val: DashboardHealth) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    try {
      const req = httpGet({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => { chunks.push(c); });
        res.on('end', () => {
          let version: string | null = null;
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
            if (typeof parsed?.version === 'string') version = parsed.version;
          } catch { /* old server or non-JSON — version stays null */ }
          done({ up: (res.statusCode ?? 0) > 0, version });
        });
        res.on('error', () => done({ up: true, version: null }));
      });
      req.on('error', () => done({ up: false, version: null }));
      req.on('timeout', () => {
        req.destroy();
        done({ up: false, version: null });
      });
    } catch {
      done({ up: false, version: null });
    }
  });
}

/**
 * Ask a running dashboard server to exit via POST /api/admin/shutdown.
 * Resolves true when the server acknowledged (2xx). Servers older than the
 * version handshake 404 this — resolves false, never throws.
 */
export function requestDashboardShutdown(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val: boolean) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    try {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/api/admin/shutdown', method: 'POST', timeout: timeoutMs },
        (res) => {
          res.resume();
          done((res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300);
        },
      );
      req.on('error', () => done(false));
      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.end();
    } catch {
      done(false);
    }
  });
}

/**
 * Probe whether a dashboard server is already listening on the loopback port.
 * Any HTTP response (or even a refused-but-listening socket) counts as "up".
 * Resolves false on connection error or timeout — never throws.
 */
export function isDashboardUp(port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val: boolean) => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    try {
      const req = httpGet({ host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs }, (res) => {
        res.resume(); // drain so the socket can close
        done((res.statusCode ?? 0) > 0);
      });
      req.on('error', () => done(false));
      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
    } catch {
      done(false);
    }
  });
}

/**
 * Launch `dreamcontext dashboard` as a detached background process that outlives
 * this hook (and the agent session). Re-invokes the current CLI entry with the
 * running Node binary so it works regardless of how dreamcontext was installed.
 */
function spawnDashboard(port: number): void {
  const cliEntry = process.argv[1];
  if (!cliEntry) return;
  const child = spawn(process.execPath, [cliEntry, 'dashboard', '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.unref();
}

/**
 * Recompute the used-asset drift cache in a DETACHED process. The compute uses
 * the real installers (async + log to stdout), so it must not run inline in this
 * sync, stdout-sensitive hook. `stdio: 'ignore'` discards the installer chatter;
 * the child writes only the cache file the snapshot reads. Best-effort.
 */
function spawnAssetDriftRefresh(): void {
  const cliEntry = process.argv[1];
  if (!cliEntry) return;
  const child = spawn(process.execPath, [cliEntry, 'hook', 'refresh-asset-drift'], {
    detached: true,
    stdio: 'ignore',
    cwd: process.cwd(),
  });
  child.unref();
}

/**
 * Launch a non-blocking, PATH-safe `brain sync --pull-only` (C2), mirroring
 * `spawnDashboard`/`spawnAssetDriftRefresh` above exactly — same guard, same
 * detached/unref discipline. Content lands on the NEXT session (the one-
 * session lag is the documented tradeoff of staying non-blocking here).
 */
function spawnBrainPull(root: string): void {
  const cliEntry = process.argv[1];
  if (!cliEntry) return;
  const child = spawn(process.execPath, [cliEntry, 'brain', 'sync', '--pull-only'], {
    detached: true,
    stdio: 'ignore',
    cwd: root,
  });
  child.unref();
}

// ─── Command Registration ───────────────────────────────────────────────────

export function registerHookCommand(program: Command): void {
  const hook = program
    .command('hook')
    .description('Hook handlers for Claude Code (stop, session-start, subagent-start, pre-tool-use, user-prompt-submit, post-tool-use, pre-compact)');

  // --- hook stop ---
  hook
    .command('stop')
    .description('Record session metadata (called by Claude Code Stop hook)')
    .action(() => {
      const input = readStdin();
      if (!input) {
        if (process.stdin.isTTY) {
          console.error('This command is called by the Claude Code Stop hook.');
          console.error('It reads JSON from stdin and should not be called manually.');
        }
        process.exit(0);
      }

      const root = resolveContextRoot();
      if (!root) process.exit(0);

      const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
      const transcriptPath = typeof input.transcript_path === 'string' ? input.transcript_path : null;
      const lastAssistantMessage = typeof input.last_assistant_message === 'string'
        ? input.last_assistant_message : null;

      if (!sessionId) process.exit(0);

      // Keep the embedded-tab session map fresh on every completed turn (see the
      // session-start handler for the full story). Belt-and-suspenders: a `/clear`
      // followed by an instant app quit can lose the SessionStart record to the hook
      // timeout — the next finished turn re-records it.
      recordTabSessionFromHook(root, sessionId);

      const state = readSleepState(root);
      const stoppedAt = new Date().toISOString();

      // Analyze the transcript immediately when it's on disk so change_count,
      // tool_count, and score are populated at write time. Claude Code ≥2.1.x
      // buffers a LIVE session's transcript in memory and flushes `<uuid>.jsonl`
      // only on exit/rotation — so at Stop time the file usually doesn't exist
      // yet. Scoring a missing file as 0 would permanently zero the session's
      // sleep debt (the re-stop dedupe overwrites, and the SessionStart catch-up
      // only touches score === null). Leave the score NULL (pending) instead:
      // the catch-up finalizes it once the flushed transcript appears, and
      // zero-finalizes after 7 days if it never does (hard-killed tab).
      const transcriptOnDisk = !!transcriptPath && existsSync(transcriptPath);
      const analysis = transcriptOnDisk ? analyzeTranscript(transcriptPath) : ZERO_ANALYSIS;
      const { changeCount, toolCount } = analysis;
      // Substance-weighted debt (WS-DEBT): max() with the substance ladder keeps
      // the score bounded at 3 and only raises the FLOOR for edit-free-but-dense
      // sessions; it never lowers an edit-heavy score.
      const score = transcriptOnDisk
        ? Math.max(
          scoreFromChangeCount(changeCount),
          scoreFromToolCount(toolCount),
          scoreFromSubstance(analysis),
        )
        : null;

      // Link unlinked bookmarks to this session
      for (const bookmark of state.bookmarks) {
        if (!bookmark.session_id) {
          bookmark.session_id = sessionId;
        }
      }

      // Derive task_slugs: merge transcript-extracted slugs with bookmark task_slug values
      const bookmarkTaskSlugs = state.bookmarks
        .filter(b => b.session_id === sessionId && b.task_slug)
        .map(b => b.task_slug!);
      const transcriptTaskSlugs = analysis.taskSlugs;
      const taskSlugs = [...new Set([...transcriptTaskSlugs, ...bookmarkTaskSlugs])];

      const upsertInput: StopUpsertInput = {
        session_id: sessionId,
        transcript_path: transcriptPath,
        stopped_at: stoppedAt,
        last_assistant_message: lastAssistantMessage,
        change_count: transcriptOnDisk ? changeCount : null,
        tool_count: transcriptOnDisk ? toolCount : null,
        score,
        task_slugs: taskSlugs,
      };
      const nextState = upsertSessionOnStop(state, upsertInput);

      writeSleepState(root, nextState);
    });

  // True when THIS hook fires from a claude process NESTED inside the embedded tab's
  // own claude — e.g. the agent ran `claude -p "…"` via its Bash tool, or the user
  // dropped to a subshell and launched claude. DREAMCONTEXT_TAB_SESSION is inherited
  // by every descendant of the tab's PTY, so without this guard the nested one-shot's
  // SessionStart/Stop would remap the tab to a throwaway conversation (wrong resume,
  // stats, and title from then on). Detection: walk the process ancestry counting
  // claude-like commands — the hook's OWN claude is the nearest one; any ADDITIONAL
  // claude above it means we're nested. The walk STOPS at the dashboard server's pid
  // (DREAMCONTEXT_SERVER_PID, exported into the PTY env): anything above the server —
  // e.g. a dev server itself launched from inside a Claude Code session — is OUTSIDE
  // the tab, and counting it would misclassify every legitimate embedded tab as nested
  // and silently disable session recording on exactly this repo's dogfooding loop.
  // ONE `ps` snapshot walked in memory (this runs on every SessionStart AND Stop hook;
  // one exec per hop cost ~4-8 sequential spawns per hook fire). POSIX-only (`ps`); on
  // Windows or any error we fail OPEN (record), preserving pre-guard behavior.
  function isNestedClaudeHook(): boolean {
    if (process.platform === 'win32') return false;
    try {
      const out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], {
        encoding: 'utf-8', timeout: 2000, maxBuffer: 8 * 1024 * 1024,
      });
      const table = new Map<number, { ppid: number; command: string }>();
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (m) table.set(Number(m[1]), { ppid: Number(m[2]), command: m[3] });
      }
      const serverPid = Number(process.env.DREAMCONTEXT_SERVER_PID || 0);
      let pid = process.ppid;
      let claudes = 0;
      for (let hop = 0; hop < 15 && pid > 1; hop++) {
        // Tab boundary: the server spawned the tab's PTY, so once the walk reaches it
        // every remaining ancestor is outside the tab. (Absent on older servers → the
        // walk continues to pid 1, accepting the pre-boundary behavior.)
        if (serverPid && pid === serverPid) break;
        const p = table.get(pid);
        if (!p) break;
        // Match `claude` as a command word (bare or path-tail), not path fragments
        // like `~/.claude/…` (preceded by a dot) — the wrapper `sh -c 'claude -p …'`
        // matching too is fine: that only happens on the nested path we want to skip.
        if (/(^|[\s/])claude($|\s)/.test(p.command)) claudes++;
        if (claudes >= 2) return true;
        pid = p.ppid;
      }
    } catch { /* ancestry unreadable → fail open */ }
    return false;
  }

  // The one shared gate for recording an embedded tab's session rotation — both hook
  // handlers (Stop + SessionStart) funnel through here so the contract (env var, UUID
  // gates, nested-claude guard, swallow-all-errors posture) can never drift between
  // them. The cheap UUID checks run BEFORE the `ps`-snapshot ancestry walk, so a
  // non-tab session never pays for it. Wrapped so this can NEVER break a hook.
  function recordTabSessionFromHook(root: string, sessionId: string): void {
    try {
      const tabId = process.env.DREAMCONTEXT_TAB_SESSION;
      if (!tabId || !UUID_RE.test(tabId) || !UUID_RE.test(sessionId)) return;
      if (isNestedClaudeHook()) return;
      recordAgentSession(root, tabId, sessionId);
    } catch { /* best-effort — resume falls back to the pinned id */ }
  }

  // --- hook session-start ---
  hook
    .command('session-start')
    .description('Analyze previous session + output context snapshot (called by Claude Code SessionStart hook)')
    .action(() => {
      const input = readStdin();

      const root = resolveContextRoot();
      if (!root) {
        // No brain at all. If cwd is a real project, surface the initializer
        // offer (the no-brain trigger) before exiting. Own try/catch so this
        // detection can NEVER turn a clean "no context, stay silent" into a crash.
        try {
          if (process.env.DREAMCONTEXT_INITIALIZER_HOOK !== '0') {
            const trigger = detectSessionStartTrigger(process.cwd(), null);
            if (trigger) console.log(renderOffer(trigger));
          }
        } catch (initErr) {
          if (process.env.DREAMCONTEXT_DEBUG) console.error('[initializer] error:', (initErr as Error).message ?? initErr);
        }
        process.exit(0);
      }

      // ── Embedded-tab session tracking ────────────────────────────────────
      // The dashboard's embedded terminal exports DREAMCONTEXT_TAB_SESSION=<the tab's
      // roster id> into its `claude` process. A tab's LIVE conversation id rotates
      // underneath it (`/clear` starts a new session file; the in-TUI resume picker
      // switches conversations), and SessionStart is the only place the new id is
      // observable (startup|resume|compact|clear all land here). Record
      // roster id → current id so reopening the tab resumes what was actually on
      // screen, not the conversation frozen at the last rotation.
      const sid = input && typeof input.session_id === 'string' ? input.session_id : '';
      if (sid) recordTabSessionFromHook(root, sid);

      // Seed core/taxonomy.json on installs that predate the taxonomy system, so
      // tagging behaviors work from the very first session after an upgrade —
      // no user action, no waiting for a sleep cycle. Never overwrites; wrapped
      // so a filesystem error can NEVER break the SessionStart hook.
      try {
        ensureTaxonomyFile(root);
      } catch {
        // non-fatal: doctor surfaces a missing taxonomy.json, sleep-product Pass C retries
      }

      const state = readSleepState(root);
      let dirty = false;

      // Analyze all unanalyzed sessions (score === null)
      for (const session of state.sessions) {
        if (session.score !== null) continue;
        if (!session.transcript_path) {
          session.change_count = 0;
          session.tool_count = 0;
          session.score = 0;
          dirty = true;
          continue;
        }
        // Transcript not flushed yet (Claude Code ≥2.1.x writes `<uuid>.jsonl` only on
        // exit/rotation): the session may still be LIVE in another tab — leave it
        // pending for a later start instead of zero-finalizing real work. After 7 days
        // assume the file will never appear (hard-killed tab, hand-cleaned ~/.claude)
        // and finalize at zero so the debt ledger stops carrying ghosts. A missing or
        // unparseable stopped_at counts as aged out — finalize rather than pend forever.
        if (!existsSync(session.transcript_path)) {
          const stoppedMs = Date.parse(session.stopped_at ?? '') || 0;
          if (Date.now() - stoppedMs < 7 * 24 * 60 * 60 * 1000) continue;
          session.change_count = 0;
          session.tool_count = 0;
          session.score = 0;
          dirty = true;
          continue;
        }

        const analysis = analyzeTranscript(session.transcript_path);
        const score = Math.max(
          scoreFromChangeCount(analysis.changeCount),
          scoreFromToolCount(analysis.toolCount),
          scoreFromSubstance(analysis),
        );
        session.change_count = analysis.changeCount;
        session.tool_count = analysis.toolCount;
        session.score = score;
        state.debt += score;
        dirty = true;
      }

      // ── Continuous capture (C1 + C2) — SessionStart catch-up only ──────────
      // Mine each session that has a transcript and no existing digest: write a
      // bounded digest (C1) and append structurally-detected auto-bookmarks (C2).
      // This is DELIBERATELY off the synchronous Stop hook (latency-sensitive) —
      // SessionStart already amortises transcript work. Each session is wrapped
      // in its own try/catch so a single bad transcript can NEVER break the hook.
      for (const session of state.sessions) {
        if (!session.transcript_path) continue;
        // Unflushed transcript (live session on CLI ≥2.1.x) — distilling the missing
        // file would write an EMPTY digest that then permanently blocks the real one
        // (digestExists gates this loop). Skip; a later start catches it up.
        if (!existsSync(session.transcript_path)) continue;
        // A PARTIAL digest (written by the PreCompact hook mid-session) does
        // not block the catch-up: the full-transcript digest supersedes it.
        if (digestExists(root, session.session_id) && !digestIsPartial(root, session.session_id)) continue;
        try {
          const distilled = distillTranscript(session.transcript_path);

          // C1: bounded digest.
          const md = buildDigest(distilled);
          writeDigest(root, session.session_id, md);

          // C2: auto-salience → bookmarks. Skip any whose message already exists
          // (explicit or prior-auto) to avoid duplicates across catch-up runs.
          const taskSlug = session.task_slugs?.[0] ?? null;
          for (const moment of detectSalience(distilled)) {
            const exists = state.bookmarks.some(b => b.message === moment.message);
            if (exists) continue;
            const bookmark: Bookmark = {
              id: generateId('bm'),
              message: moment.message,
              salience: moment.salience,
              created_at: new Date().toISOString(),
              session_id: session.session_id,
              task_slug: taskSlug,
            };
            state.bookmarks.unshift(bookmark);
            dirty = true;
          }
        } catch (digestErr) {
          if (process.env.DREAMCONTEXT_DEBUG) {
            console.error('[digest] error:', (digestErr as Error).message ?? digestErr);
          }
        }
      }

      if (dirty) {
        writeSleepState(root, state);
      }

      // Generate and output snapshot
      const snapshot = generateSnapshot();
      if (!snapshot) process.exit(0);

      const directive = getConsolidationDirective(state);
      if (directive) {
        console.log(directive);
      }

      // Sparse-brain detection: a `_dream_context/` that is still the empty init
      // shell (empty knowledge/, zero features, untouched template core) should
      // proactively offer the initializer. Own try/catch — must never break the
      // snapshot/directive/sleep-debt path below.
      try {
        if (process.env.DREAMCONTEXT_INITIALIZER_HOOK !== '0') {
          const trigger = detectSessionStartTrigger(process.cwd(), root);
          if (trigger) console.log(renderOffer(trigger));
        }
      } catch (initErr) {
        if (process.env.DREAMCONTEXT_DEBUG) console.error('[initializer] error:', (initErr as Error).message ?? initErr);
      }

      // Session-start background brain pull (github-cloud-collaboration-brain-repo-sync,
      // M1, corrects C2): non-blocking, PATH-safe detached spawn — never a bare
      // `dreamcontext` (Finder-launched apps inherit only a minimal PATH). Own
      // try/catch so this can never break the snapshot. Surfaces the PREVIOUS
      // pull's results (this run's pull lands on the NEXT session — the
      // documented non-blocking tradeoff).
      try {
        if (process.env.DREAMCONTEXT_BRAIN_SYNC !== '0') {
          const projectRoot = dirname(root);
          const cfg = readSetupConfig(projectRoot);
          const enabledResolution = resolveBrainSyncEnabled(projectRoot, cfg);
          // Both pushing modes fetch team updates in the background: `separate`
          // (brain repo) and `full-repo` (whole project → origin). `in-tree` is
          // commit-only and has no remote to pull from.
          const pullMode = cfg?.brainRepo?.mode;
          if (enabledResolution.enabled && (pullMode === 'separate' || pullMode === 'full-repo') && cfg?.brainRepo?.autoSync) {
            spawnBrainPull(root);
          }
          const local = readBrainLocal(projectRoot);
          if (local.pulledUpdates && local.pulledUpdates > 0) {
            console.log(`ℹ ${local.pulledUpdates} update(s) from your team were merged in.`);
          }
          if (local.pendingAgentMerge) {
            console.log('⚠ Some brain updates need /dream-sync to reconcile.');
          }
          // C2 (github-cloud-collaboration-brain-repo-sync M3): the background
          // pull never auto-runs the task backend sync itself (best-effort,
          // non-blocking) — surface the instruction instead of doing it silently.
          if (local.needsTaskSync) {
            console.log('ℹ Task mirrors are out of date after a team merge — run `dreamcontext tasks sync` to refresh them.');
          }
        }
      } catch (brainErr) {
        if (process.env.DREAMCONTEXT_DEBUG) console.error('[brain-sync] error:', (brainErr as Error).message ?? brainErr);
      }

      console.log(snapshot);
    });

  // --- hook pre-tool-use ---
  hook
    .command('pre-tool-use')
    .description('Gate default sub-agents when _dream_context/ exists (called by Claude Code PreToolUse hook)')
    .action(() => {
      const input = readStdin();
      if (!input) process.exit(0); // allow — no input means nothing to gate

      const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
      const toolInput = (typeof input.tool_input === 'object' && input.tool_input !== null)
        ? input.tool_input as Record<string, unknown>
        : {};

      // Gate 1: block direct writes/edits to _dream_context/marketing/.env
      // (Edit, Write, MultiEdit). Token files must only be touched by `mk init`
      // or by the user manually outside an agent session.
      if (toolName === 'Edit' || toolName === 'Write' || toolName === 'MultiEdit') {
        const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
        if (isMarketingEnvPath(filePath)) {
          console.log(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: [
                'Blocked: _dream_context/marketing/.env holds Meta access tokens.',
                'Agents must never write this file directly — initial setup is `mk init`,',
                'and rotation is a manual user action outside an agent session.',
                'If you need to verify config, run `dreamcontext mk config check`.',
              ].join(' '),
            },
          }));
          return;
        }
      }

      // Gate 2: redirect default Explore agent to dreamcontext-explore.
      if (toolName !== 'Agent') process.exit(0); // allow

      const subagentType = typeof toolInput.subagent_type === 'string'
        ? toolInput.subagent_type : '';

      // Only gate the default Explore agent. Case/whitespace-tolerant so a casing
      // variant ("explore") still hits the gate, while never matching our own
      // redirect target ("dreamcontext-explore", which !== "explore").
      if (subagentType.trim().toLowerCase() !== 'explore') process.exit(0); // allow

      // Only gate when _dream_context/ exists (context-managed projects)
      const root = resolveContextRoot();
      if (!root) process.exit(0); // allow — no context directory, default Explorer is fine

      // Block default Explorer and redirect to context-aware version
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: [
            'Default Explorer blocked: this project has _dream_context/ with curated context.',
            'Use Agent with subagent_type "dreamcontext-explore" instead.',
            'It checks context files first (data structures, tech stack, features) before searching the codebase,',
            'saving thousands of tokens. Pass the same prompt — it has identical search capabilities.',
          ].join(' '),
        },
      }));
    });

  // --- hook subagent-start ---
  hook
    .command('subagent-start')
    .description('Inject context briefing into sub-agents (called by Claude Code SubagentStart hook)')
    .action(() => {
      const root = resolveContextRoot();
      if (!root) process.exit(0);

      const briefing = generateSubagentBriefing();
      if (!briefing) process.exit(0);

      // SubagentStart hooks must output JSON with hookSpecificOutput.additionalContext
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SubagentStart',
          additionalContext: briefing,
        },
      }));
    });

  // --- hook user-prompt-submit ---
  hook
    .command('user-prompt-submit')
    .description('Inject sleep debt reminder on every user message (called by Claude Code UserPromptSubmit hook)')
    .action(async () => {
      const input = readStdin();
      if (!input) process.exit(0);

      const root = resolveContextRoot();
      if (!root) process.exit(0);

      // ── Embedded-tab first-prompt capture (the auto-title source) ────────────
      // Claude Code ≥2.1.x buffers a live session's transcript in memory and only
      // flushes `<uuid>.jsonl` on exit/rotation — so the dashboard's auto-title
      // route can no longer read the first user message from disk while a tab is
      // LIVE. This hook is the one place that prompt is observable in real time:
      // record the conversation's first title-worthy prompt into the tab's
      // session-map entry for /agent/title to fall back to. Runs BEFORE the
      // consolidation-lock early return below — a mid-sleep tab still deserves a
      // title. The write-once check runs before the `ps`-ancestry walk, so the
      // common case (already captured) costs one file read, not a process-table
      // scan. Wrapped: can NEVER break the reminder/recall path.
      try {
        const tabId = process.env.DREAMCONTEXT_TAB_SESSION ?? '';
        const sid = typeof input.session_id === 'string' ? input.session_id : '';
        const prompt = titleWorthyPrompt(String((input as Record<string, unknown>).prompt ?? ''));
        if (prompt && UUID_RE.test(tabId) && UUID_RE.test(sid)) {
          const entry = readAgentSessionEntry(root, tabId);
          const captured = entry?.current === sid && !!entry.firstPrompt;
          if (!captured && !isNestedClaudeHook()) recordAgentFirstPrompt(root, tabId, sid, prompt);
        }
      } catch { /* best-effort — auto-title falls back to the transcript when it lands */ }

      const state = readSleepState(root);

      // Debt/bookmark reminder — pure logic extracted to userPromptReminder so it
      // is unit-testable. Returns null below the threshold (stay silent). The
      // "consolidation in progress" early-return must still short-circuit the
      // rest of this handler, so re-check that condition here.
      const reminder = userPromptReminder(state);
      // A non-stale lock means a sleep is genuinely mid-cycle — short-circuit the
      // rest of the handler (initializer/recall gates) just like the reminder does.
      // A stale lock (crashed sleep) must NOT keep suppressing these forever.
      const lock = inspectSleepLock(state, Date.now());
      if (lock.locked && !lock.stale) {
        if (reminder) console.log(reminder);
        return;
      }
      if (reminder) console.log(reminder);

      // Initializer opportunity (migrate-from-folder / mass-new-source): the user
      // is pointing at an existing brain/notes folder to MIGRATE, or a sizable new
      // external source to INGEST into this already-initialized brain. Requires
      // both intent and an existing on-disk source, so normal prompts stay silent.
      // Own try/catch — must never break recall, the skills gate, or the rest of
      // this handler. Suppressed during sleep by the early return above; honor the
      // env opt-out for parity with the other gates.
      if (process.env.DREAMCONTEXT_INITIALIZER_HOOK !== '0') {
        try {
          const prompt = String((input as Record<string, unknown>).prompt ?? '');
          const trigger = detectPromptTrigger(prompt, { cwd: process.cwd(), root });
          if (trigger) console.log(renderOffer(trigger));
        } catch (initErr) {
          if (process.env.DREAMCONTEXT_DEBUG) console.error('[initializer] error:', (initErr as Error).message ?? initErr);
        }
      }

      // Marketing nudge: only fires when there are unconfirmed Performance
      // Monitor recommendations from >24h ago. Must NOT fire on every prompt
      // (per task contract). Wrapped in try/catch so the marketing skill-pack
      // never breaks the core hook.
      try {
        const stale = listStaleRecs(24);
        if (stale.length > 0) {
          const ids = stale.slice(0, 3).map((e) => e.id).join(', ');
          const more = stale.length > 3 ? ` (+${stale.length - 3} more)` : '';
          console.log(
            `${stale.length} marketing recommendation${stale.length === 1 ? '' : 's'} pending >24h: ${ids}${more}. ` +
            `Review with \`mk learnings list-pending\` and confirm/reject.`,
          );
        }
      } catch {
        // Marketing snapshot must never break the hook.
      }

      // Version refresh — lazy, gated (at most once per 24h TTL).
      // Only runs when cache is absent or stale. Never throws — version check is
      // best-effort and must not affect hook reliability. Honor opt-out env var.
      // NOTE: root = _dream_context/ dir; readVersionCache / refreshVersionCache
      // expect project root (parent of _dream_context/), hence dirname(root).
      if (process.env.DREAMCONTEXT_VERSION_CHECK !== '0') {
        try {
          const projectRoot = dirname(root);
          let vcache = readVersionCache(projectRoot);
          if (!isCacheFresh(vcache)) {
            const loaded = loadCatalog();
            const packNames: string[] = loaded
              ? [
                  ...loaded.catalog.packs.map((p) => p.name),
                  ...loaded.catalog.standalone.map((s) => s.name),
                ]
              : [];
            refreshVersionCache(projectRoot, { catalogPackNames: packNames });
            vcache = readVersionCache(projectRoot);
            // Piggyback on the ≤once/24h refresh tick: if the desktop app is
            // installed, trigger a best-effort background app update (rare —
            // only a new Tauri shell release replaces the bundle; the app runs
            // the global CLI for everything else). No-ops until releases exist.
            maybeTriggerAppUpdate();
            // Piggyback too: refresh the used-asset drift verdict in a detached
            // process so the SessionStart "stale assets" nag can stay silent when
            // a CLI bump didn't actually change any pack this project installs.
            // The child no-ops fast when there's no version drift to scope.
            spawnAssetDriftRefresh();
          }
          // Auto-upgrade (DEFAULT ON; opt out with DREAMCONTEXT_AUTO_UPGRADE=0):
          // detached, non-blocking, at most once per target version per 24h.
          // Emits a one-line notice only when it actually fires.
          const notice = maybeAutoUpgrade(projectRoot, dreamcontextVersion(), vcache);
          if (notice) console.log(notice);
        } catch {
          // Version check must never break the hook.
        }
      }

      // Context gate accumulators — drive the behavioural directive emitted
      // after the recall + skills blocks. We inject a BEHAVIOUR (read related
      // memory, recall more by keyword, check for an existing task) — never a
      // hard "read file X" list, because the recall above can be noisy and
      // naming files reads as "read exactly these". hadRecallHits = recall
      // surfaced something; gatedSkills = a related skill surfaced.
      let hadRecallHits = false;
      let gatedSkills = false;

      // Memory recall injection — single Haiku call sees corpus index + prompt,
      // returns only relevant docs. Falls back to raw BM25 if Haiku fails.
      // Mode via the shared resolver so the hook, `memory recall`, and /api/recall
      // never disagree (env override, else persisted .sleep.json, else 'haiku').
      if (process.env.DREAMCONTEXT_MEMORY_HOOK !== '0') {
        try {
          const prompt = String((input as Record<string, unknown>).prompt ?? '');
          if (prompt.trim().length >= 8) {
            const recallMode = resolveRecallMode(root);

            if (recallMode !== 'off') {
              let hits: RecallHit[] = [];
              let mode = 'BM25';

              if (recallMode === 'haiku') {
                const result = haikuRecall(prompt, root);
                if (result === 'skip') {
                  if (process.env.DREAMCONTEXT_DEBUG) console.error('[recall] Haiku: skip (no searchable intent)');
                } else if (result !== null && result.length > 0) {
                  hits = result;
                  mode = 'Haiku';
                } else if (result !== null && result.length === 0) {
                  if (process.env.DREAMCONTEXT_DEBUG) console.error('[recall] Haiku: 0 docs selected');
                } else if (result === null) {
                  if (process.env.DREAMCONTEXT_DEBUG) console.error('[recall] Haiku failed, falling back to BM25');
                  const corpus = buildCorpus(root);
                  hits = bm25Search(prompt, corpus, 3);
                }
              } else if (hybridReady(root, recallMode)) {
                // EXPERIMENTAL: BM25 + dense RRF fusion (decision-embedding-layer).
                // `hybridReady` gates on model-downloaded AND cache-warm, so a
                // prompt never triggers a surprise 113 MB download or a cold
                // multi-minute index build. (A per-process ~1s model cold-load
                // to embed the query is still paid on the first hybrid recall in
                // each short-lived hook process — inherent to hybrid mode.) Raw
                // `.score` is untouched, so the >= 2.0 gate below is unchanged.
                const corpus = buildCorpus(root);
                hits = await hybridSearch(prompt, corpus, root, 3);
                mode = 'Hybrid';
              } else {
                const corpus = buildCorpus(root);
                hits = bm25Search(prompt, corpus, 3);
              }

              // Hits are ordered by rankScore (field/recency/synonym signals), but the
              // gate must test the RAW BM25 score, which may not sit at index 0 after
              // re-ranking. Use .some() so a strong raw match isn't suppressed by a
              // lower-raw-score doc winning the rankScore sort.
              if (hits.length > 0 && (mode === 'Haiku' || hits.some((h) => h.score >= 2.0))) {
                const lines: string[] = ['', `— Memory recall (${mode}, top ${hits.length}) —`];
                for (const h of hits) {
                  lines.push(`  [${h.doc.type}] ${h.doc.relPath}`);
                  if (h.snippet) lines.push(`    Why: ${h.snippet}`);
                  else if (h.doc.description) lines.push(`    ${h.doc.description}`);
                  const excerpt = h.doc.body
                    .split('\n')
                    .map(l => l.trim())
                    .filter(l => l.length > 0 && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('|'))
                    .slice(0, 3)
                    .join(' ')
                    .slice(0, 200);
                  if (excerpt) lines.push(`    > ${excerpt}${excerpt.length >= 200 ? '…' : ''}`);
                }
                console.log(lines.join('\n'));
                hadRecallHits = true;

                // C4: a recall hit on a knowledge doc IS an access — bump
                // knowledge_access for each `knowledge` hit, then persist once.
                // This feeds staleness/warm-knowledge tracking from real recall
                // usage, not just explicit `knowledge touch` calls.
                let bumped = false;
                for (const h of hits) {
                  if (h.doc.type === 'knowledge') {
                    bumpKnowledgeAccess(state, h.doc.slug);
                    bumped = true;
                  }
                }
                if (bumped) writeSleepState(root, state);
              }

              // ── Cross-vault LIVE READ (read-only federation) ──────────────
              // When this vault has read connections (out/both) to shareable
              // peers, surface THEIR canonical docs at query time — a live
              // reference, never a copy. Zero added cost when there are no
              // connections: resolveConnectedVaults returns only the current
              // vault and we skip entirely.
              try {
                const { target: currentTarget } = currentVaultTarget(dirname(root));
                const peerTargets = resolveConnectedVaults(currentTarget, root).filter(
                  (t) => t.current !== true,
                );
                if (peerTargets.length > 0) {
                  const { hits: peerHits } = crossVaultRecall(prompt, {
                    vaults: peerTargets,
                    topK: 3,
                  });
                  const strong = peerHits.filter((h: FederatedHit) => h.score >= 2.0);
                  if (strong.length > 0) {
                    const lines: string[] = ['', `— Connected peers (live read, top ${strong.length}) —`];
                    for (const h of strong) {
                      lines.push(`  [${h.doc.type}] ${h.vault}::${h.doc.relPath}`);
                      if (h.snippet) lines.push(`    Why: ${h.snippet}`);
                      else if (h.doc.description) lines.push(`    ${h.doc.description}`);
                    }
                    lines.push(
                      '  (Live reference — recall the source vault directly with ' +
                        '`dreamcontext memory recall <q> --vault <name>`. Nothing is copied here.)',
                    );
                    console.log(lines.join('\n'));
                    hadRecallHits = true;
                  }
                }
              } catch (peerErr) {
                if (process.env.DREAMCONTEXT_DEBUG) console.error('[recall] peer read error:', (peerErr as Error).message ?? peerErr);
              }
            }
          }
        } catch (recallErr) {
          if (process.env.DREAMCONTEXT_DEBUG) console.error('[recall] error:', (recallErr as Error).message ?? recallErr);
        }
      }

      // Skill-relevance signal — we do NOT print a limited "top-N skills" list.
      // The full skill catalogue (every skill + description) is already injected
      // into the agent's context by the harness, so listing a BM25-picked subset
      // would only anchor the agent on a few and risk omitting the right one.
      // Instead we cheaply check whether ANY installed skill plausibly relates to
      // the prompt; if so, the gate below tells the agent to review the FULL list
      // itself and invoke whatever fits. alwaysApply skills are excluded by
      // loadSkillDocs (they're always loaded — no point flagging them). The
      // `sleep_started_at` early-return above suppresses this during sleep.
      // Own try/catch so it can never throw out of the action.
      if (process.env.DREAMCONTEXT_SKILLS_HOOK !== '0') {
        try {
          const prompt = String((input as Record<string, unknown>).prompt ?? '');
          if (prompt.trim().length >= 8) {
            const skillsRoot = join(process.cwd(), '.claude', 'skills');
            const docs = loadSkillDocs(skillsRoot);
            if (docs.length > 0 && bm25Search(prompt, docs, 5).some(h => h.score >= SKILL_SCORE_THRESHOLD)) {
              gatedSkills = true;
            }
          }
        } catch (skillErr) {
          if (process.env.DREAMCONTEXT_DEBUG) console.error('[skills] error:', (skillErr as Error).message ?? skillErr);
        }
      }

      // ── Context gate (behavioural bootstrap) ──────────────────────────────
      // When the prompt relates to project work (recall surfaced something, or a
      // skill matched), inject the BEHAVIOUR the agent must follow before acting:
      // read the related knowledge/feature memory, recall more by keyword for
      // depth, and check for an existing task. We never name specific files —
      // the recall block above lists candidates; the agent judges relevance.
      // Pure string ops over local state, so no try/catch needed.
      if (hadRecallHits || gatedSkills) {
        const g: string[] = ['', '⛔ Before you act, get the full picture from project memory — not optional:'];
        if (hadRecallHits) {
          g.push('  • READ the related knowledge/feature file(s) recalled above in full (Read tool) — plus anything relevant in your knowledge index. The source code will NOT show the decisions and constraints they hold.');
        }
        if (process.env.DREAMCONTEXT_SKILLS_HOOK !== '0') {
          g.push('  • REVIEW the skills available to you (the full list is already in your context) and INVOKE any that fit this task via the Skill tool — do NOT limit yourself to a pre-selected few; scan them all and decide.');
        }
        g.push('  • For depth, RECALL more: dreamcontext memory recall "<your keywords>" [--types knowledge,feature,task,memory] — try a few keyword sets and read the relevant hits in full.');
        g.push('  • CHECK whether a task already exists for this work: dreamcontext memory recall "<keywords>" --types task (or look in _dream_context/state/). If one exists, follow it; if the work is untracked and non-trivial, create one.');
        g.push('  Act only once the relevant memory is in your context — be the agent that has seen the whole picture, not one re-deriving it blind.');
        console.log(g.join('\n'));
      }
    });

  // --- hook post-tool-use ---
  hook
    .command('post-tool-use')
    .description('Auto-format + type-check after Edit/Write on JS/TS files (called by Claude Code PostToolUse hook)')
    .action(() => {
      const input = readStdin();
      if (!input) process.exit(0);

      const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
      if (toolName !== 'Edit' && toolName !== 'Write') process.exit(0);

      const toolInput = (typeof input.tool_input === 'object' && input.tool_input !== null)
        ? input.tool_input as Record<string, unknown>
        : {};
      const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : '';
      if (!filePath || !isJsTsFile(filePath)) process.exit(0);

      const messages: string[] = [];

      // Single walk-up pass for both formatter and tsconfig
      const config = findProjectConfig(filePath);

      // Phase 1: Auto-format
      if (config.formatter) {
        const result = runFormatter(config.formatter, filePath);
        if (result.success) {
          messages.push(`Formatted ${basename(filePath)} with ${config.formatter.type}.`);
        }
      }

      // Phase 2: TypeScript check (use pre-found tsconfig)
      if (config.tsconfig) {
        const tsErrors = runTscCheckWithConfig(filePath, config.tsconfig);
        if (tsErrors) {
          messages.push(tsErrors);
        }
      }

      if (messages.length > 0) {
        console.log(JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: messages.join('\n\n'),
          },
        }));
      }
    });

  // --- hook pre-compact ---
  hook
    .command('pre-compact')
    .description('Save sleep state before context compaction (called by Claude Code PreCompact hook)')
    .action(() => {
      const input = readStdin();

      const root = resolveContextRoot();
      if (!root) process.exit(0);

      const state = readSleepState(root);
      const trigger = (input && typeof input.trigger === 'string') ? input.trigger : 'unknown';

      // Prepend the compaction record (LIFO, capped at 20) via the pure helper.
      const nextState = appendCompactionRecord(state, {
        timestamp: new Date().toISOString(),
        trigger,
        debt_at_compaction: state.debt,
        sessions_count: state.sessions.length,
        bookmarks_count: state.bookmarks.length,
      });

      writeSleepState(root, nextState);

      // ── Pre-compaction capture: digest the live transcript NOW. ───────────
      // Compaction is where mid-session decisions die: the agent's context is
      // summarised away, the session hasn't ended, and the Stop-hook capture
      // path is hours away. Digesting here puts the pre-compaction decisions
      // into the recall corpus IMMEDIATELY — the very next UserPromptSubmit
      // recall can re-surface what compaction just dropped, in the SAME
      // session. The digest is marked `partial: true`; the SessionStart
      // catch-up re-digests the full transcript over it after the session
      // ends. Best-effort: a bad transcript must never break compaction.
      try {
        const sessionId = (input && typeof input.session_id === 'string') ? input.session_id : '';
        const transcriptPath = (input && typeof input.transcript_path === 'string') ? input.transcript_path : '';
        if (sessionId && transcriptPath && existsSync(transcriptPath)) {
          const distilled = distillTranscript(transcriptPath);
          writeDigest(root, sessionId, buildDigest(distilled), { partial: true });
        }
      } catch {
        // never block compaction
      }
    });

  // --- hook refresh-asset-drift ---
  hook
    .command('refresh-asset-drift')
    .description('Recompute whether `dreamcontext update` would change any asset this project uses (detached cache refresh)')
    .action(async () => {
      // Drain any piped hook payload so stdin doesn't block; contents unused.
      readStdin();
      try {
        const root = resolveContextRoot();
        if (root) await runAssetDriftRefresh(root);
      } catch {
        // Best-effort cache refresh — must never surface or fail anything.
      }
      process.exit(0);
    });

  // --- hook ensure-dashboard ---
  hook
    .command('ensure-dashboard')
    .description('Windows only: open the web dashboard if it is not already running (called by Claude Code SessionStart hook)')
    .action(async () => {
      // Drain any piped hook payload so stdin doesn't block; contents unused.
      readStdin();

      // Windows ONLY. macOS has the desktop app as its dashboard surface, so a
      // browser auto-open there is redundant at best. Gated at runtime (not at
      // hook-install time) because .claude settings can be shared across a team
      // on mixed OSes. Everyone can still run `dreamcontext dashboard` by hand.
      if (process.platform !== 'win32') process.exit(0);

      // Opt-out: DREAMCONTEXT_AUTO_DASHBOARD=0 disables auto-open entirely.
      if (process.env.DREAMCONTEXT_AUTO_DASHBOARD === '0') process.exit(0);

      // If the desktop app is installed, it owns the dashboard/launcher surface —
      // auto-opening a browser tab here would be redundant and confusing. Skip
      // entirely (the user can still run `dreamcontext dashboard` by hand).
      if (readAppManifest() !== null) process.exit(0);

      // Only for context-managed projects — nothing to show otherwise.
      const root = resolveContextRoot();
      if (!root) process.exit(0);

      const port = resolveDashboardPort();

      // A server already on the port is reused ONLY when it runs THIS version.
      // A long-lived server left over from before an upgrade serves the new
      // dashboard bundle with an old route table — the "No route: POST
      // /api/tasks/token" failure. On version mismatch (or a pre-handshake
      // server with no version at all), ask it to exit and respawn fresh.
      const health = await fetchDashboardHealth(port);
      if (health.up) {
        if (health.version === dreamcontextVersion()) process.exit(0);

        const acknowledged = await requestDashboardShutdown(port);
        if (acknowledged) {
          // Server shutdown: 150ms response-flush timer + close (≤5s force-exit).
          // Poll until the port frees so the respawn can't EADDRINUSE-die.
          for (let i = 0; i < 8 && (await isDashboardUp(port, 300)); i++) {
            await new Promise((r) => setTimeout(r, 350));
          }
        }
        if (await isDashboardUp(port, 300)) {
          // Old server without the shutdown route (or one that won't die) — we
          // can't kill an unknown PID portably. Tell the agent/user what to do.
          console.log(
            `dreamcontext: the dashboard server on port ${port} is running an older version ` +
            `(${health.version ?? 'unknown (older)'}, current v${dreamcontextVersion()}) — its API is stale. ` +
            `Stop that process, then run \`dreamcontext dashboard\`.`,
          );
          process.exit(0);
        }
        try {
          spawnDashboard(port);
          console.log(
            `dreamcontext: restarted the dashboard at http://localhost:${port} ` +
            `(the previous server was v${health.version ?? 'unknown'}, now v${dreamcontextVersion()}).`,
          );
        } catch { /* best-effort */ }
        process.exit(0);
      }

      try {
        spawnDashboard(port);
        // SessionStart stdout becomes agent context — keep it to a single line.
        console.log(
          `dreamcontext: opened the dashboard at http://localhost:${port} ` +
          `(auto-open; set DREAMCONTEXT_AUTO_DASHBOARD=0 to disable).`,
        );
      } catch {
        // Auto-open is a convenience — it must never break session start.
      }
      process.exit(0);
    });
}
