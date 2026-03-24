import { Command } from 'commander';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { ensureContextRoot } from '../../lib/context-path.js';
import { readSleepState, readSleepHistory } from './sleep.js';
import { error, info } from '../../lib/format.js';

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
      input?: Record<string, unknown>;
      content?: string | Array<{ text?: string }>;
    }>;
  };
  subagent?: {
    result?: string;
  };
}

interface DistilledSection {
  userMessages: string[];
  agentDecisions: string[];
  codeChanges: string[];
  errors: string[];
  bookmarks: string[];
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
          // Collect all text from array content (multiple text blocks, tool results, etc)
          for (const block of msg.content) {
            if (typeof block === 'string') {
              text += block + ' ';
            } else if (block && typeof block === 'object') {
              // Handle text blocks: {type: "text", text: "..."}
              if (block.type === 'text' && typeof block.text === 'string') {
                text += block.text + ' ';
              }
              // Handle tool result blocks that may have content array
              else if ((block as Record<string, unknown>).type === 'tool_result' && Array.isArray((block as Record<string, unknown>).content)) {
                const content = (block as Record<string, unknown>).content as Array<unknown>;
                for (const contentBlock of content) {
                  if (typeof contentBlock === 'string') {
                    text += contentBlock + ' ';
                  } else if (contentBlock && typeof contentBlock === 'object' && (contentBlock as Record<string, unknown>).type === 'text') {
                    text += ((contentBlock as Record<string, unknown>).text || '') + ' ';
                  }
                }
              }
            }
          }
        }
        const trimmed = text.trim();
        if (trimmed && trimmed.length > 0) {
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
    .description('Extract high-signal content from a session transcript (pure structural filtering)')
    .action((sessionId: string, opts: { since?: string; full?: boolean }) => {
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

      if (!existsSync(session.transcript_path)) {
        error(`Transcript file not found: ${session.transcript_path}`);
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

      const distilled = distillTranscript(session.transcript_path, sinceTimestamp);
      console.log(formatDistilled(sessionId, distilled, sinceTimestamp));
    });
}
