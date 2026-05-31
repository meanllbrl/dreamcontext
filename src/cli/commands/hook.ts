import { Command } from 'commander';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { dirname, resolve, join, extname, basename, relative } from 'node:path';
import { resolveContextRoot } from '../../lib/context-path.js';
import type { SleepState } from './sleep.js';
import { readSleepState, writeSleepState } from './sleep.js';
import { generateSnapshot, generateSubagentBriefing } from './snapshot.js';
import { listStaleRecs } from '../../lib/marketing/snapshot.js';
import { isMarketingEnvPath } from '../../lib/marketing/path-guards.js';
import { buildCorpus, bm25Search, loadSkillDocs, type RecallHit } from '../../lib/recall.js';
import { haikuRecall } from '../../lib/recall-query-extractor.js';
import { readVersionCache, isCacheFresh, refreshVersionCache } from '../../lib/version-check.js';
import { loadCatalog } from './install-skill.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50MB safety cap

// Related-skills recall: lower threshold than memory's 2.0 because alwaysApply
// skills are filtered out and the skill corpus is tiny/curated.
const SKILL_SCORE_THRESHOLD = 1.0;
const MAX_RELATED_SKILLS = 3;

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
}

const ZERO_ANALYSIS: TranscriptAnalysis = { changeCount: 0, toolCount: 0, taskSlugs: [] };

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

    return {
      changeCount: changeMatches ? changeMatches.length : 0,
      toolCount: toolMatches ? toolMatches.length : 0,
      taskSlugs: [...slugs],
    };
  } catch {
    return ZERO_ANALYSIS;
  }
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

function getConsolidationDirective(state: SleepState): string | null {
  const { debt, bookmarks, sessions_since_last_sleep, sleep_started_at } = state;

  // If consolidation is already in progress, suppress all directives to prevent duplicate sleeps
  if (sleep_started_at) {
    if (debt >= 4) {
      return [
        `> Consolidation already in progress (started: ${sleep_started_at}). Do NOT dispatch another sleep agent.`,
        '',
      ].join('\n');
    }
    return null;
  }

  // Check for critical (★★★) bookmarks that need immediate consolidation
  const criticalBookmarks = bookmarks.filter(b => b.salience === 3);

  if (debt >= 10) {
    return [
      '>>> CONSOLIDATION REQUIRED <<<',
      '',
      `Sleep debt is ${debt} (threshold: 10). Context files are stale and bloated.`,
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
  if (debt >= 7) {
    return [
      '>> CONSOLIDATION RECOMMENDED <<',
      '',
      `Sleep debt is ${debt}/10. Context files are growing stale.`,
      'You MUST inform the user and recommend consolidation before starting new work.',
      'Run sleep consolidation: follow SKILL.md "Sleep" flow — main agent does `sleep start`, then dispatches sleep-tasks/sleep-state (and sleep-product when signals warrant) in parallel, then `sleep done`.',
      '',
    ].join('\n');
  }
  if (debt >= 4) {
    return [
      `> Sleep debt is ${debt}. After completing the current task, you MUST offer to consolidate.`,
      '',
    ].join('\n');
  }
  if (sessions_since_last_sleep >= 3) {
    return [
      `> ${sessions_since_last_sleep} sessions since last consolidation. After completing the current task, offer to consolidate.`,
      '',
    ].join('\n');
  }
  return null;
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

      const state = readSleepState(root);
      const stoppedAt = new Date().toISOString();

      // Analyze transcript immediately so change_count, tool_count, and score are populated at write time
      const analysis = transcriptPath ? analyzeTranscript(transcriptPath) : ZERO_ANALYSIS;
      const { changeCount, toolCount } = analysis;
      const score = Math.max(scoreFromChangeCount(changeCount), scoreFromToolCount(toolCount));

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

      // Check if session already exists (e.g., stop fired twice for same session)
      const existing = state.sessions.findIndex(s => s.session_id === sessionId);
      if (existing >= 0) {
        // Subtract old score before updating (avoid double-counting on re-stop)
        const oldScore = state.sessions[existing].score ?? 0;
        state.debt = Math.max(0, state.debt - oldScore);

        state.sessions[existing].transcript_path = transcriptPath;
        state.sessions[existing].stopped_at = stoppedAt;
        state.sessions[existing].last_assistant_message = lastAssistantMessage;
        state.sessions[existing].change_count = changeCount;
        state.sessions[existing].tool_count = toolCount;
        state.sessions[existing].score = score;
        // Merge task_slugs on re-stop
        const existingSlugs = state.sessions[existing].task_slugs ?? [];
        state.sessions[existing].task_slugs = [...new Set([...existingSlugs, ...taskSlugs])];
      } else {
        state.sessions.unshift({
          session_id: sessionId,
          transcript_path: transcriptPath,
          stopped_at: stoppedAt,
          last_assistant_message: lastAssistantMessage,
          change_count: changeCount,
          tool_count: toolCount,
          score,
          task_slugs: taskSlugs,
        });
      }

      // Add current score to debt
      state.debt += score;

      // Increment rhythm counter (only for new sessions, not re-stops)
      if (existing < 0) {
        state.sessions_since_last_sleep = (state.sessions_since_last_sleep || 0) + 1;
      }

      writeSleepState(root, state);
    });

  // --- hook session-start ---
  hook
    .command('session-start')
    .description('Analyze previous session + output context snapshot (called by Claude Code SessionStart hook)')
    .action(() => {
      const input = readStdin();

      const root = resolveContextRoot();
      if (!root) process.exit(0);

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

        const analysis = analyzeTranscript(session.transcript_path);
        const score = Math.max(scoreFromChangeCount(analysis.changeCount), scoreFromToolCount(analysis.toolCount));
        session.change_count = analysis.changeCount;
        session.tool_count = analysis.toolCount;
        session.score = score;
        state.debt += score;
        dirty = true;
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

      // Only gate the default Explore agent
      if (subagentType !== 'Explore') process.exit(0); // allow

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
    .action(() => {
      const input = readStdin();
      if (!input) process.exit(0);

      const root = resolveContextRoot();
      if (!root) process.exit(0);

      const state = readSleepState(root);
      const { debt, bookmarks, sleep_started_at } = state;

      // If consolidation is already in progress, suppress debt reminders to prevent duplicate sleeps
      if (sleep_started_at) {
        if (debt >= 4) {
          console.log(`Consolidation already in progress (started: ${sleep_started_at}). Do NOT dispatch another sleep agent.`);
        }
        return;
      }

      const criticalBookmarks = bookmarks.filter(b => b.salience === 3);

      // Only output when debt is actionable or critical bookmarks exist
      if (debt >= 10) {
        console.log(`Sleep debt is ${debt}. CONSOLIDATION REQUIRED. Run sleep flow per SKILL.md (parallel specialist fan-out) NOW.`);
      } else if (criticalBookmarks.length > 0) {
        console.log(`${criticalBookmarks.length} critical bookmark(s) need consolidation. Run sleep flow per SKILL.md.`);
      } else if (debt >= 7) {
        console.log(`Sleep debt is ${debt}. Consolidation recommended before starting new work.`);
      } else if (debt >= 4) {
        console.log(`Sleep debt is ${debt}. After completing the current task, offer to consolidate.`);
      }
      // debt < 4 and no critical bookmarks: silent (no output)

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
          const vcache = readVersionCache(projectRoot);
          if (!isCacheFresh(vcache)) {
            const loaded = loadCatalog();
            const packNames: string[] = loaded
              ? [
                  ...loaded.catalog.packs.map((p) => p.name),
                  ...loaded.catalog.standalone.map((s) => s.name),
                ]
              : [];
            refreshVersionCache(projectRoot, { catalogPackNames: packNames });
          }
        } catch {
          // Version check must never break the hook.
        }
      }

      // Context gate accumulators — drive the hard "read before code" directive
      // emitted after the recall + skills blocks below. gatedDocs collects the
      // surfaced knowledge/feature docs the agent MUST read first; gatedSkills
      // flags that a related skill was surfaced and must be invoked if it fits.
      const gatedDocs: string[] = [];
      let gatedSkills = false;

      // Memory recall injection — single Haiku call sees corpus index + prompt,
      // returns only relevant docs. Falls back to raw BM25 if Haiku fails.
      // Priority: env var > state file > default 'haiku'.
      if (process.env.DREAMCONTEXT_MEMORY_HOOK !== '0') {
        try {
          const prompt = String((input as Record<string, unknown>).prompt ?? '');
          if (prompt.trim().length >= 8) {
            const recallMode = process.env.DREAMCONTEXT_RECALL_MODE ?? state.recall_mode ?? 'haiku';

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
              } else {
                const corpus = buildCorpus(root);
                hits = bm25Search(prompt, corpus, 3);
              }

              if (hits.length > 0 && (mode === 'Haiku' || hits[0].score >= 2.0)) {
                const lines: string[] = ['', `— Memory recall (${mode}, top ${hits.length}) —`];
                for (const h of hits) {
                  lines.push(`  [${h.doc.type}] ${h.doc.relPath}`);
                  // Knowledge/feature docs encode decisions the code won't show —
                  // the agent must read them before acting (see context gate below).
                  if (h.doc.type === 'knowledge' || h.doc.type === 'feature') gatedDocs.push(h.doc.relPath);
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
              }
            }
          }
        } catch (recallErr) {
          if (process.env.DREAMCONTEXT_DEBUG) console.error('[recall] error:', (recallErr as Error).message ?? recallErr);
        }
      }

      // Related-skills injection — BM25-match the prompt against top-level skill
      // packs in <projectRoot>/.claude/skills and suggest invoking the best fits
      // via the Skill tool. alwaysApply skills are filtered out by loadSkillDocs.
      // NOTE: the `sleep_started_at` early-return above intentionally suppresses
      // this block during consolidation sessions (no code needed here).
      // Own try/catch so it can never throw out of the action.
      if (process.env.DREAMCONTEXT_SKILLS_HOOK !== '0') {
        try {
          const prompt = String((input as Record<string, unknown>).prompt ?? '');
          if (prompt.trim().length >= 8) {
            const projectRoot = process.cwd();
            const skillsRoot = join(projectRoot, '.claude', 'skills');
            const docs = loadSkillDocs(skillsRoot);
            if (docs.length > 0) {
              const hits = bm25Search(prompt, docs, MAX_RELATED_SKILLS)
                .filter(h => h.score >= SKILL_SCORE_THRESHOLD);
              if (hits.length > 0) {
                const lines: string[] = ['', `— Related skills (top ${hits.length}) —`];
                lines.push('  Invoke these via the Skill tool BEFORE acting if they fit the task:');
                for (const h of hits) {
                  const desc = h.doc.description.length > 120
                    ? h.doc.description.slice(0, 120) + '…'
                    : h.doc.description;
                  lines.push(`  • ${h.doc.slug}${desc ? ` — ${desc}` : ''}`);
                }
                console.log(lines.join('\n'));
                gatedSkills = true;
              }
            }
          }
        } catch (skillErr) {
          if (process.env.DREAMCONTEXT_DEBUG) console.error('[skills] error:', (skillErr as Error).message ?? skillErr);
        }
      }

      // ── Context gate (hard rule) ──────────────────────────────────────────
      // If a knowledge/feature doc or a related skill surfaced above, the agent
      // MUST consume it before reading source code or acting. Surfaced context
      // is not optional reading — this is the behavioral bootstrap. Pure string
      // ops over local state, so no try/catch needed.
      if (gatedDocs.length > 0 || gatedSkills) {
        const g: string[] = ['', '⛔ BEFORE reading source code or acting on this task — REQUIRED (not optional):'];
        if (gatedDocs.length > 0) {
          g.push(`  • READ the knowledge/feature doc(s) above FIRST with the Read tool: ${gatedDocs.join(', ')}`);
          g.push('    They encode decisions and constraints the source code will NOT show. Do not open source files until you have.');
        }
        if (gatedSkills) {
          g.push('  • INVOKE the related skill(s) above via the Skill tool if they fit — required, not "if you like".');
        }
        g.push('  • Need more? Run: dreamcontext memory recall "<keywords from this task>" for precise context.');
        g.push('  Skipping this repeats past mistakes, misses constraints, and burns tokens re-exploring.');
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

      state.compaction_log.unshift({
        timestamp: new Date().toISOString(),
        trigger,
        debt_at_compaction: state.debt,
        sessions_count: state.sessions.length,
        bookmarks_count: state.bookmarks.length,
      });

      // Cap at 20 entries (anti-bloat)
      if (state.compaction_log.length > 20) {
        state.compaction_log = state.compaction_log.slice(0, 20);
      }

      writeSleepState(root, state);
    });
}
