import { Command } from 'commander';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { dirname, resolve, join, extname, basename, relative } from 'node:path';
import { resolveContextRoot } from '../../lib/context-path.js';
import type { SleepState } from './sleep.js';
import { readSleepState, writeSleepState } from './sleep.js';
import { generateSnapshot, generateSubagentBriefing } from './snapshot.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50MB safety cap

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
}

const ZERO_ANALYSIS: TranscriptAnalysis = { changeCount: 0, toolCount: 0 };

/**
 * Analyze a JSONL transcript file for tool usage.
 * Returns change count (Write/Edit) and total tool count.
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
    return {
      changeCount: changeMatches ? changeMatches.length : 0,
      toolCount: toolMatches ? toolMatches.length : 0,
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
  const { debt, bookmarks, sessions_since_last_sleep } = state;

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
      'Dispatch the agentcontext-rem-sleep agent with a brief of recent work.',
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
      'Dispatch the agentcontext-rem-sleep agent with a brief of recent work.',
      '',
    ].join('\n');
  }
  if (debt >= 7) {
    return [
      '>> CONSOLIDATION RECOMMENDED <<',
      '',
      `Sleep debt is ${debt}/10. Context files are growing stale.`,
      'You MUST inform the user and recommend consolidation before starting new work.',
      'Dispatch the agentcontext-rem-sleep agent with a brief of recent work.',
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
      } else {
        state.sessions.unshift({
          session_id: sessionId,
          transcript_path: transcriptPath,
          stopped_at: stoppedAt,
          last_assistant_message: lastAssistantMessage,
          change_count: changeCount,
          tool_count: toolCount,
          score,
        });
      }

      // Add current score to debt
      state.debt += score;

      // Link unlinked bookmarks to this session by timestamp range
      for (const bookmark of state.bookmarks) {
        if (!bookmark.session_id) {
          bookmark.session_id = sessionId;
        }
      }

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
    .description('Gate default sub-agents when _agent_context/ exists (called by Claude Code PreToolUse hook)')
    .action(() => {
      const input = readStdin();
      if (!input) process.exit(0); // allow — no input means nothing to gate

      const toolName = typeof input.tool_name === 'string' ? input.tool_name : '';
      const toolInput = (typeof input.tool_input === 'object' && input.tool_input !== null)
        ? input.tool_input as Record<string, unknown>
        : {};

      // Only gate Agent tool calls with specific subagent_types
      if (toolName !== 'Agent') process.exit(0); // allow

      const subagentType = typeof toolInput.subagent_type === 'string'
        ? toolInput.subagent_type : '';

      // Only gate the default Explore agent
      if (subagentType !== 'Explore') process.exit(0); // allow

      // Only gate when _agent_context/ exists (context-managed projects)
      const root = resolveContextRoot();
      if (!root) process.exit(0); // allow — no context directory, default Explorer is fine

      // Block default Explorer and redirect to context-aware version
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: [
            'Default Explorer blocked: this project has _agent_context/ with curated context.',
            'Use Agent with subagent_type "agentcontext-explore" instead.',
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
      const { debt, bookmarks } = state;
      const criticalBookmarks = bookmarks.filter(b => b.salience === 3);

      // Only output when debt is actionable or critical bookmarks exist
      if (debt >= 10) {
        console.log(`Sleep debt is ${debt}. CONSOLIDATION REQUIRED. Run agentcontext-rem-sleep NOW.`);
      } else if (criticalBookmarks.length > 0) {
        console.log(`${criticalBookmarks.length} critical bookmark(s) need consolidation. Run agentcontext-rem-sleep.`);
      } else if (debt >= 7) {
        console.log(`Sleep debt is ${debt}. Consolidation recommended before starting new work.`);
      } else if (debt >= 4) {
        console.log(`Sleep debt is ${debt}. After completing the current task, offer to consolidate.`);
      }
      // debt < 4 and no critical bookmarks: silent (no output)
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
