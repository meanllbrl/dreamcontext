import { Command } from 'commander';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readSleepState, readSleepHistory } from './sleep.js';
import { error, info } from '../../lib/format.js';
import {
  resolveTranscript, listSubagentTranscripts, subagentIdFromPath, DIR_LAYOUT_MAIN_CANDIDATES,
} from '../../lib/transcript-locate.js';
import type { TranscriptLocation } from '../../lib/transcript-locate.js';

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024; // 50MB safety cap

// Tool calls that represent noise (exploration, not decisions)
const NOISE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ToolSearch',
]);

// Tool calls that represent meaningful changes
const CHANGE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

interface TranscriptEntry {
  type: string;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<{
      type: string;
      name?: string;
      text?: string;
      thinking?: string;
      input?: Record<string, unknown>;
      content?: string | Array<{ text?: string }>;
    }>;
  };
  subagent?: {
    result?: string;
  };
}

export interface DistilledSection {
  userMessages: string[];
  agentDecisions: string[];
  codeChanges: string[];
  errors: string[];
  bookmarks: string[];
}

/**
 * True when a `role:user` transcript turn is system-injected sub-agent /
 * tooling coordination noise rather than a real human message. These turns
 * structurally resemble a user message (they arrive on the `user` role as
 * tool results or harness injections) but carry ZERO durable lesson content:
 *
 *   1. `<task-notification>` XML blocks (background sub-agent completion pings)
 *   2. agent-resume JSON — `{"success":true,"message":"Agent ... resumed ..."}`
 *   3. skill-loader headers — `Base directory for this skill: ...`
 *
 * They must never seed a 'User correction' bookmark (salience auto-capture runs
 * over `userMessages`) nor bloat a session digest. Substring-anchored: a turn
 * that merely CONTAINS one of these blocks is treated as noise, because in
 * practice the harness emits each on its own dedicated turn. See task_OwbFN_IV.
 */
export function isSystemNoiseMessage(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  // 1. Sub-agent task-notification XML blocks.
  if (/<\/?task-notification\b/i.test(t)) return true;
  // 2. Agent-resume JSON: a success envelope referencing an Agent resume.
  if (
    /"success"\s*:\s*(?:true|false)/.test(t) &&
    /\bAgent\b/.test(t) &&
    /(?:resumed|no active task)/i.test(t)
  ) {
    return true;
  }
  // 3. Skill-loader header echoed verbatim into the turn.
  if (/Base directory for this skill\s*:/i.test(t)) return true;
  return false;
}

/**
 * Parse a JSONL transcript file and extract high-signal content.
 * Pure Node.js structural filtering, no AI.
 * If sinceTimestamp is provided, only entries after that timestamp are included.
 */
export function distillTranscript(transcriptPath: string, sinceTimestamp?: string): DistilledSection {
  const result: DistilledSection = {
    userMessages: [],
    agentDecisions: [],
    codeChanges: [],
    errors: [],
    bookmarks: [],
  };

  if (!existsSync(transcriptPath)) return result;

  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0 || stat.size > MAX_TRANSCRIPT_BYTES) return result;

    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      let entry: TranscriptEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      // Filter by timestamp if sinceTimestamp is provided
      if (sinceTimestamp && entry.timestamp && entry.timestamp <= sinceTimestamp) continue;

      if (!entry.message) continue;
      const msg = entry.message;

      // User messages: always keep
      if (msg.role === 'user') {
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Collect ONLY genuine user-typed text. In Claude Code transcripts a
          // tool result is stored as a role:'user' record carrying a
          // `tool_result` block — that is machine output, NOT something the human
          // typed. Folding it into userMessages let tool output (e.g. Playwright
          // "No open tabs") seed false 'User correction' bookmarks, so we skip
          // tool_result blocks here. Genuine typed text always arrives as a
          // string or a {type:'text'} block. See task_OwbFN_IV.
          for (const block of msg.content) {
            if (typeof block === 'string') {
              text += block + ' ';
            } else if (block && typeof block === 'object') {
              // Handle text blocks: {type: "text", text: "..."}
              if (block.type === 'text' && typeof block.text === 'string') {
                text += block.text + ' ';
              }
              // tool_result blocks are deliberately ignored (machine output).
            }
          }
        }
        const trimmed = text.trim();
        // Drop system-injected coordination noise (sub-agent notifications,
        // agent-resume JSON, skill-loader headers) BEFORE it can be mined as a
        // user message — otherwise salience auto-capture misclassifies it as a
        // 'User correction' bookmark. See task_OwbFN_IV.
        if (trimmed && trimmed.length > 0 && !isSystemNoiseMessage(trimmed)) {
          result.userMessages.push(trimmed);
        }
        continue;
      }

      // Assistant messages
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          // Agent text responses (all, including trivial)
          if (block.type === 'text' && block.text) {
            const text = block.text.trim();
            if (text.length > 0) {
              result.agentDecisions.push(text);
            }
          }

          // Thinking blocks (internal reasoning)
          if (block.type === 'thinking' && block.thinking) {
            const thinking = (typeof block.thinking === 'string' ? block.thinking : '').trim();
            if (thinking.length > 0) {
              result.agentDecisions.push(`[thinking] ${thinking}`);
            }
          }

          // Tool calls
          if (block.type === 'tool_use' && block.name) {
            const toolName = block.name;

            // Bookmark calls
            if (toolName === 'Bash' && block.input) {
              const cmd = typeof block.input.command === 'string' ? block.input.command : '';
              if (cmd.includes('dreamcontext bookmark')) {
                result.bookmarks.push(cmd);
                continue;
              }
            }

            // Write/Edit: record full change
            if (CHANGE_TOOLS.has(toolName) && block.input) {
              const filePath = typeof block.input.file_path === 'string' ? block.input.file_path : '';
              if (toolName === 'Write') {
                const content = typeof block.input.content === 'string' ? block.input.content : '';
                const lines = content.split('\n').length;
                result.codeChanges.push(`WRITE ${filePath} (${lines} lines)\n${content}`);
              } else if (toolName === 'Edit') {
                const oldStr = typeof block.input.old_string === 'string' ? block.input.old_string : '';
                const newStr = typeof block.input.new_string === 'string' ? block.input.new_string : '';
                result.codeChanges.push(`EDIT ${filePath}\n--- OLD ---\n${oldStr}\n--- NEW ---\n${newStr}`);
              } else if (toolName === 'NotebookEdit') {
                const nbPath = typeof block.input.notebook_path === 'string' ? block.input.notebook_path : '';
                result.codeChanges.push(`NOTEBOOK_EDIT ${nbPath}`);
              }
              continue;
            }

            // Bash commands that modify files
            if (toolName === 'Bash' && block.input) {
              const cmd = typeof block.input.command === 'string' ? block.input.command : '';
              // Detect modifying bash commands
              if (/\b(npm install|npm i |yarn add|pnpm add|pip install|git |mkdir |rm |mv |cp |chmod |chown |sed |awk )/.test(cmd)) {
                result.codeChanges.push(`BASH ${cmd}`);
              }
              continue;
            }

            // Skip noise tools entirely
            if (NOISE_TOOLS.has(toolName)) continue;

            // Task tool (subagent I/O): show input prompt and final answer
            if (toolName === 'Task' && block.input) {
              const prompt = typeof block.input.prompt === 'string' ? block.input.prompt : '';
              if (prompt.length > 20) {
                result.agentDecisions.push(`[subagent-task] ${prompt}`);
              }
              continue;
            }
          }
        }
        continue;
      }

      // Tool results: check for errors and subagent outputs
      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const text = typeof block.text === 'string' ? block.text : '';

            // Errors
            if (/error|Error|ERROR|failed|Failed|FAILED|exception|Exception/.test(text)) {
              result.errors.push(text);
            }

            // Subagent outputs (from Task tool results)
            if (text.length > 20 && text.includes('[subagent]')) {
              result.agentDecisions.push(`[subagent-result] ${text}`);
            }
          }
        }
      }

      // Subagent final answers
      if (entry.subagent?.result) {
        const subResult = entry.subagent.result.trim();
        if (subResult.length > 20) {
          result.agentDecisions.push(`[subagent] ${subResult}`);
        }
      }
    }
  } catch {
    // Return whatever we have so far
  }

  return result;
}

/**
 * Merge multiple distilled sections into one, preserving the order sections
 * (and items within each section) were given, and deduping each of the five
 * arrays independently (a string repeated across sections — e.g. main +
 * sub-agent both hitting the same error — collapses to one entry).
 */
export function mergeDistilled(sections: DistilledSection[]): DistilledSection {
  const result: DistilledSection = {
    userMessages: [], agentDecisions: [], codeChanges: [], errors: [], bookmarks: [],
  };
  const seen: Record<keyof DistilledSection, Set<string>> = {
    userMessages: new Set(), agentDecisions: new Set(), codeChanges: new Set(),
    errors: new Set(), bookmarks: new Set(),
  };
  for (const section of sections) {
    for (const key of Object.keys(result) as Array<keyof DistilledSection>) {
      for (const item of section[key]) {
        if (seen[key].has(item)) continue;
        seen[key].add(item);
        result[key].push(item);
      }
    }
  }
  return result;
}

/**
 * Distill every `<sessionDir>/subagents/agent-*.jsonl` found via `loc` and
 * merge them into one section (AC8 sub-agent harvest). Subagent transcripts
 * carry the same `message.role`/`message.content` shape as the main
 * transcript (`isSidechain: true`, `agentId` — verified 2026-07-18), so
 * `distillTranscript` parses them as-is. Each subagent's `agentDecisions` are
 * prefixed `[subagent:<id>]` so a harvested finding is traceable back to the
 * dispatching agent. `[]` sessionDir / no subagent files → an all-empty
 * section (never throws — `listSubagentTranscripts` already guards fs).
 */
export function distillSubagents(
  loc: TranscriptLocation,
  opts: { max?: number; sinceTimestamp?: string } = {},
): DistilledSection {
  const paths = listSubagentTranscripts(loc, { max: opts.max });
  const sections = paths.map((p) => {
    const id = subagentIdFromPath(p);
    const distilled = distillTranscript(p, opts.sinceTimestamp);
    return {
      ...distilled,
      agentDecisions: distilled.agentDecisions.map((d) => `[subagent:${id}] ${d}`),
    };
  });
  return mergeDistilled(sections);
}

/**
 * Format a distilled transcript as markdown.
 */
export function formatDistilled(sessionId: string, distilled: DistilledSection, sinceTimestamp?: string): string {
  const suffix = sinceTimestamp ? ` (since ${sinceTimestamp})` : '';
  const parts: string[] = [`## Session ${sessionId} -- Distilled Transcript${suffix}\n`];

  if (distilled.userMessages.length > 0) {
    parts.push('### User Messages');
    for (const m of distilled.userMessages) {
      parts.push(`- "${m}"`);
    }
    parts.push('');
  }

  if (distilled.agentDecisions.length > 0) {
    parts.push('### Agent Decisions & Reasoning');
    for (const d of distilled.agentDecisions) {
      parts.push(`- ${d}`);
    }
    parts.push('');
  }

  if (distilled.codeChanges.length > 0) {
    parts.push('### Code Changes');
    for (const c of distilled.codeChanges) {
      parts.push(`- ${c}`);
    }
    parts.push('');
  }

  if (distilled.errors.length > 0) {
    parts.push('### Errors & Issues');
    for (const e of distilled.errors) {
      parts.push(`- ${e}`);
    }
    parts.push('');
  }

  if (distilled.bookmarks.length > 0) {
    parts.push('### Bookmarks');
    for (const b of distilled.bookmarks) {
      parts.push(`- ${b}`);
    }
    parts.push('');
  }

  return parts.join('\n');
}

export function registerTranscriptCommand(program: Command): void {
  const transcript = program
    .command('transcript')
    .description('Process session transcripts');

  transcript
    .command('distill')
    .argument('<session_id>', 'Session ID to distill')
    .option('--since <timestamp>', 'Only include content after this ISO timestamp')
    .option('--full', 'Show full transcript (skip auto-filter by last consolidation)')
    .option('--subagents', "Also merge in this session's sub-agent transcripts (<sessionDir>/subagents/agent-*.jsonl)")
    .description('Extract high-signal content from a session transcript (pure structural filtering)')
    .action((sessionId: string, opts: { since?: string; full?: boolean; subagents?: boolean }) => {
      const root = ensureContextRoot();
      const state = readSleepState(root);

      const session = state.sessions.find(s => s.session_id === sessionId);
      if (!session) {
        error(`Session not found: ${sessionId}`);
        return;
      }

      if (!session.transcript_path) {
        error(`No transcript path for session: ${sessionId}`);
        return;
      }

      // Shared resolver: probes the FLAT layout first (`<projectDir>/<sessionId>.jsonl`,
      // still what Claude Code writes today), then the DIR layout
      // (`<projectDir>/<sessionId>/`), so a future transcript-location change
      // degrades gracefully instead of silently reporting "not found".
      const loc = resolveTranscript(session.transcript_path, { sessionId });
      if (!loc.mainPath) {
        const projectDir = dirname(session.transcript_path);
        const flatPath = join(projectDir, `${sessionId}.jsonl`);
        const dirPath = join(projectDir, sessionId);
        if (loc.layout === 'dir') {
          error(
            `Transcript not found for session: ${sessionId}.`,
            `Probed flat: ${flatPath} (not found); dir: ${dirPath} (exists, but no main transcript — checked ${DIR_LAYOUT_MAIN_CANDIDATES.join(', ')}).`,
          );
        } else {
          error(
            `Transcript not found for session: ${sessionId}.`,
            `Probed flat: ${flatPath} (not found); dir: ${dirPath} (not found).`,
          );
        }
        return;
      }

      // Determine since timestamp: --since overrides, --full disables, default auto-detects
      let sinceTimestamp: string | undefined;
      if (opts.since) {
        sinceTimestamp = opts.since;
      } else if (!opts.full) {
        // Auto-detect: find the most recent consolidation that processed this session
        const history = readSleepHistory(root);
        const lastConsolidation = history.find(h =>
          Array.isArray(h.session_ids) && h.session_ids.includes(sessionId)
        );
        if (lastConsolidation?.consolidated_at) {
          sinceTimestamp = lastConsolidation.consolidated_at;
          info(`Auto-filtering: showing content after last consolidation (${lastConsolidation.consolidated_at})`);
        }
      }

      let distilled = distillTranscript(loc.mainPath, sinceTimestamp);
      if (opts.subagents) {
        const subagentDistilled = distillSubagents(loc, { sinceTimestamp });
        distilled = mergeDistilled([distilled, subagentDistilled]);
      }
      console.log(formatDistilled(sessionId, distilled, sinceTimestamp));
    });
}
