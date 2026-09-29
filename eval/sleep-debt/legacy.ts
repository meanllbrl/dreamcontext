/**
 * FROZEN legacy sleep-debt behaviour, the BEFORE side of `npm run verify:sleep-debt`.
 *
 * A verbatim copy of the scoring and auto-capture code as it shipped at commit
 * `7eca3421` (src/cli/commands/hook.ts, src/cli/commands/transcript.ts,
 * src/lib/salience.ts), limited to the call graph of the three exports below:
 *
 *   - legacyAnalyzeSession   hook.ts analyzeSession + analyzeTranscript (flat
 *                            `"name"` regexes, per-record usage sums, raw-line
 *                            decision markers, every user-role record a turn)
 *   - legacyScoreSession     hook.ts scoreSession with the old SCORE_AXES
 *                            (tokens k 100_000 / full 3_500_000)
 *   - legacyCaptureMoments   the SessionStart catch-up capture: distillTranscript
 *                            (main) + distillSubagents, merged, then detectSalience
 *
 * It exists so the verify script can show old vs new numbers on the same
 * transcripts after the production code has changed. Never edit it except to
 * fix a copy error against `git show 7eca3421:<file>`: a "fix" here would quietly
 * move the baseline the new code is measured against. The only departures from
 * the source are renames, comments, and dropped unused parameters
 * (`sinceTimestamp` on distill, `max` on the sub-agent harvest).
 *
 * One caveat on scores: the Stop hook unioned bookmark `task_slug`s into the
 * record, but `scoreSession` only ever saw the transcript-extracted slugs
 * reproduced here, so this matches what was actually scored.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import {
  listSubagentTranscripts,
  subagentIdFromPath,
  type TranscriptLocation,
} from '../../src/lib/transcript-locate.js';
import type { TranscriptAnalysis } from '../../src/cli/commands/hook.js';
import type { SalientMoment } from '../../src/lib/salience.js';

// ─── Constants (hook.ts / transcript.ts / salience.ts @7eca3421) ─────────────

const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BLOCK_CHARS = 20000;
const SESSION_SCORE_MAX = 10;

const LEGACY_SCORE_AXES = {
  tokens:    { k: 100_000, full: 3_500_000, weight: 4 },
  changes:   { k: 2,       full: 40,        weight: 3 },
  tools:     { k: 10,      full: 200,       weight: 1.5 },
  substance: { weight: 1.5 },
} as const;

const CORRECTION_RE =
  /^(no|nope|hayır)\b|\bactually\b|\binstead of\b|\b(wrong|incorrect)\b|\byanlış\b|öyle değil/i;
const DECISION_RE = /\b(decided|chose|switched to|will use|karar|seçtik)\b/i;

const ZERO_ANALYSIS: TranscriptAnalysis = {
  changeCount: 0, toolCount: 0, taskSlugs: [],
  userTurns: 0, assistantChars: 0, decisionMarkers: 0, novelTokens: 0,
};

// ─── Transcript analysis (hook.ts @7eca3421) ─────────────────────────────────

function recordTimestampMs(rec: object): number | null {
  const t = (rec as { timestamp?: unknown }).timestamp;
  if (typeof t !== 'string') return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

function countToolUseBlocks(rec: object): { tools: number; changes: number } {
  const r = rec as { message?: { content?: unknown }; content?: unknown };
  const content = (r.message && typeof r.message === 'object' ? r.message.content : undefined) ?? r.content;
  let tools = 0;
  let changes = 0;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as { type?: unknown; name?: unknown };
        if (b.type === 'tool_use') {
          tools++;
          if (b.name === 'Write' || b.name === 'Edit') changes++;
        }
      }
    }
  }
  return { tools, changes };
}

function recordRole(rec: object): string | null {
  const r = rec as { role?: unknown; message?: { role?: unknown } };
  if (typeof r.role === 'string') return r.role;
  if (r.message && typeof r.message === 'object' && typeof r.message.role === 'string') {
    return r.message.role;
  }
  return null;
}

function novelTokensFromUsage(rec: object): number {
  const r = rec as { usage?: unknown; message?: { usage?: unknown } };
  const raw = (r.message && typeof r.message === 'object' ? r.message.usage : undefined) ?? r.usage;
  if (!raw || typeof raw !== 'object') return 0;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
  return num(u.output_tokens) + num(u.cache_creation_input_tokens) + num(u.input_tokens);
}

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

function legacyAnalyzeTranscript(transcriptPath: string, sinceISO?: string | null): TranscriptAnalysis {
  if (!existsSync(transcriptPath)) return ZERO_ANALYSIS;
  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0 || stat.size > MAX_TRANSCRIPT_BYTES) return ZERO_ANALYSIS;
    const content = readFileSync(transcriptPath, 'utf-8');
    const sinceMs = sinceISO ? Date.parse(sinceISO) : NaN;
    const changeMatches = content.match(/"name"\s*:\s*"(?:Write|Edit)"/g);
    const toolMatches = content.match(/"name"\s*:\s*"[A-Za-z_]+"/g);

    // Task slugs feed the substance axis (">= 2 slugs" step), so they are part
    // of the frozen score, not just linkage metadata.
    const slugs = new Set<string>();
    for (const m of content.matchAll(/"command"\s*:\s*"[^"]*dreamcontext\s+tasks?\s+(?:log|insert|complete|create|status|start|reopen|rename)\s+(?:\\?["'])?([a-z0-9][a-z0-9-]*)/g)) {
      slugs.add(m[1]);
    }
    for (const m of content.matchAll(/"file_path"\s*:\s*"[^"]*_dream_context\/state\/([a-z0-9][a-z0-9-]*)\.md"/g)) {
      slugs.add(m[1]);
    }

    let userTurns = 0;
    let assistantChars = 0;
    let decisionMarkers = 0;
    let novelTokens = 0;
    let excludedAny = false;
    let boundedChanges = 0;
    let boundedTools = 0;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const isDecision = DECISION_RE.test(trimmed) || CORRECTION_RE.test(trimmed);
      let rec: unknown;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        if (isDecision) decisionMarkers++;
        continue;
      }
      if (!rec || typeof rec !== 'object') {
        if (isDecision) decisionMarkers++;
        continue;
      }
      if (!Number.isNaN(sinceMs)) {
        const ts = recordTimestampMs(rec);
        if (ts !== null && ts <= sinceMs) {
          excludedAny = true;
          continue;
        }
      }
      if (isDecision) decisionMarkers++;
      novelTokens += novelTokensFromUsage(rec);
      const role = recordRole(rec);
      if (role === 'user') {
        userTurns++;
      } else if (role === 'assistant') {
        assistantChars += sumAssistantTextChars(rec);
      }
      const uses = countToolUseBlocks(rec);
      boundedTools += uses.tools;
      boundedChanges += uses.changes;
    }

    return {
      changeCount: excludedAny ? boundedChanges : (changeMatches ? changeMatches.length : 0),
      toolCount: excludedAny ? boundedTools : (toolMatches ? toolMatches.length : 0),
      taskSlugs: [...slugs],
      userTurns,
      assistantChars,
      decisionMarkers,
      novelTokens,
    };
  } catch {
    return ZERO_ANALYSIS;
  }
}

function mergeAnalyses(main: TranscriptAnalysis, subs: TranscriptAnalysis[]): TranscriptAnalysis {
  const merged: TranscriptAnalysis = { ...main, taskSlugs: [...main.taskSlugs] };
  const slugs = new Set(merged.taskSlugs);
  for (const s of subs) {
    merged.changeCount += s.changeCount;
    merged.toolCount += s.toolCount;
    merged.assistantChars += s.assistantChars;
    merged.decisionMarkers += s.decisionMarkers;
    merged.novelTokens += s.novelTokens;
    for (const slug of s.taskSlugs) slugs.add(slug);
  }
  merged.taskSlugs = [...slugs];
  return merged;
}

/** hook.ts `analyzeSession` @7eca3421: main transcript plus every sub-agent transcript. */
export function legacyAnalyzeSession(loc: TranscriptLocation, since?: string | null): TranscriptAnalysis {
  const main = loc.mainPath ? legacyAnalyzeTranscript(loc.mainPath, since) : ZERO_ANALYSIS;
  try {
    const subPaths = listSubagentTranscripts(loc);
    if (subPaths.length === 0) return main;
    return mergeAnalyses(main, subPaths.map(p => legacyAnalyzeTranscript(p, since)));
  } catch {
    return main;
  }
}

// ─── Scoring (hook.ts @7eca3421) ─────────────────────────────────────────────

function logPoints(x: number, k: number, full: number, weight: number): number {
  if (!Number.isFinite(x) || x <= 0) return 0;
  return Math.min(weight, weight * Math.log2(1 + x / k) / Math.log2(1 + full / k));
}

function scoreFromSubstanceV2(signals: {
  userTurns: number;
  assistantChars: number;
  decisionMarkers: number;
  taskSlugs: string[];
}): number {
  let pts = 0;
  if (signals.userTurns >= 8) pts += 0.4;
  if (signals.assistantChars >= 25_000) pts += 0.4;
  if (signals.decisionMarkers >= 4) pts += 0.35;
  if (signals.taskSlugs.length >= 2) pts += 0.35;
  return Math.min(LEGACY_SCORE_AXES.substance.weight, pts);
}

/** hook.ts `scoreSession` @7eca3421, with the old SCORE_AXES. */
export function legacyScoreSession(a: TranscriptAnalysis): number {
  const ax = LEGACY_SCORE_AXES;
  const raw =
    logPoints(a.novelTokens, ax.tokens.k, ax.tokens.full, ax.tokens.weight) +
    logPoints(a.changeCount, ax.changes.k, ax.changes.full, ax.changes.weight) +
    logPoints(a.toolCount, ax.tools.k, ax.tools.full, ax.tools.weight) +
    scoreFromSubstanceV2(a);
  return Math.min(SESSION_SCORE_MAX, Math.round(raw));
}

// ─── Auto-capture (transcript.ts + salience.ts @7eca3421) ────────────────────

const NOISE_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ToolSearch',
]);
const CHANGE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit']);

interface LegacyTranscriptEntry {
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
  subagent?: { result?: string };
}

interface LegacyDistilled {
  userMessages: string[];
  agentDecisions: string[];
  codeChanges: string[];
  errors: string[];
  bookmarks: string[];
}

function emptyDistilled(): LegacyDistilled {
  return { userMessages: [], agentDecisions: [], codeChanges: [], errors: [], bookmarks: [] };
}

function isSystemNoiseMessage(text: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/<\/?task-notification\b/i.test(t)) return true;
  if (
    /"success"\s*:\s*(?:true|false)/.test(t) &&
    /\bAgent\b/.test(t) &&
    /(?:resumed|no active task)/i.test(t)
  ) {
    return true;
  }
  if (/Base directory for this skill\s*:/i.test(t)) return true;
  return false;
}

function distillTranscript(transcriptPath: string): LegacyDistilled {
  const result = emptyDistilled();
  if (!existsSync(transcriptPath)) return result;

  try {
    const stat = statSync(transcriptPath);
    if (stat.size === 0 || stat.size > MAX_TRANSCRIPT_BYTES) return result;

    const content = readFileSync(transcriptPath, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());

    for (const line of lines) {
      let entry: LegacyTranscriptEntry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (!entry.message) continue;
      const msg = entry.message;

      if (msg.role === 'user') {
        let text = '';
        if (typeof msg.content === 'string') {
          text = msg.content;
        } else if (Array.isArray(msg.content)) {
          for (const block of msg.content) {
            if (typeof block === 'string') {
              text += block + ' ';
            } else if (block && typeof block === 'object') {
              if (block.type === 'text' && typeof block.text === 'string') {
                text += block.text + ' ';
              }
            }
          }
        }
        const trimmed = text.trim();
        if (trimmed && trimmed.length > 0 && !isSystemNoiseMessage(trimmed)) {
          result.userMessages.push(trimmed);
        }
        continue;
      }

      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            const text = block.text.trim();
            if (text.length > 0) result.agentDecisions.push(text);
          }

          if (block.type === 'thinking' && block.thinking) {
            const thinking = (typeof block.thinking === 'string' ? block.thinking : '').trim();
            if (thinking.length > 0) result.agentDecisions.push(`[thinking] ${thinking}`);
          }

          if (block.type === 'tool_use' && block.name) {
            const toolName = block.name;

            if (toolName === 'Bash' && block.input) {
              const cmd = typeof block.input.command === 'string' ? block.input.command : '';
              if (cmd.includes('dreamcontext bookmark')) {
                result.bookmarks.push(cmd);
                continue;
              }
            }

            if (CHANGE_TOOLS.has(toolName) && block.input) {
              const filePath = typeof block.input.file_path === 'string' ? block.input.file_path : '';
              if (toolName === 'Write') {
                const body = typeof block.input.content === 'string' ? block.input.content : '';
                const bodyLines = body.split('\n').length;
                result.codeChanges.push(`WRITE ${filePath} (${bodyLines} lines)\n${body}`);
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

            if (toolName === 'Bash' && block.input) {
              const cmd = typeof block.input.command === 'string' ? block.input.command : '';
              if (/\b(npm install|npm i |yarn add|pnpm add|pip install|git |mkdir |rm |mv |cp |chmod |chown |sed |awk )/.test(cmd)) {
                result.codeChanges.push(`BASH ${cmd}`);
              }
              continue;
            }

            if (NOISE_TOOLS.has(toolName)) continue;

            if (toolName === 'Task' && block.input) {
              const prompt = typeof block.input.prompt === 'string' ? block.input.prompt : '';
              if (prompt.length > 20) result.agentDecisions.push(`[subagent-task] ${prompt}`);
              continue;
            }
          }
        }
        continue;
      }

      if (msg.role === 'tool' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            const text = typeof block.text === 'string' ? block.text : '';
            if (/error|Error|ERROR|failed|Failed|FAILED|exception|Exception/.test(text)) {
              result.errors.push(text);
            }
            if (text.length > 20 && text.includes('[subagent]')) {
              result.agentDecisions.push(`[subagent-result] ${text}`);
            }
          }
        }
      }

      if (entry.subagent?.result) {
        const subResult = entry.subagent.result.trim();
        if (subResult.length > 20) result.agentDecisions.push(`[subagent] ${subResult}`);
      }
    }
  } catch {
    // Return whatever we have so far (verbatim source behaviour).
  }

  return result;
}

function mergeDistilled(sections: LegacyDistilled[]): LegacyDistilled {
  const result = emptyDistilled();
  const seen: Record<keyof LegacyDistilled, Set<string>> = {
    userMessages: new Set(), agentDecisions: new Set(), codeChanges: new Set(),
    errors: new Set(), bookmarks: new Set(),
  };
  for (const section of sections) {
    for (const key of Object.keys(result) as Array<keyof LegacyDistilled>) {
      for (const item of section[key]) {
        if (seen[key].has(item)) continue;
        seen[key].add(item);
        result[key].push(item);
      }
    }
  }
  return result;
}

function distillSubagents(loc: TranscriptLocation): LegacyDistilled {
  const sections = listSubagentTranscripts(loc).map((p) => {
    const id = subagentIdFromPath(p);
    const distilled = distillTranscript(p);
    return { ...distilled, agentDecisions: distilled.agentDecisions.map((d) => `[subagent:${id}] ${d}`) };
  });
  return mergeDistilled(sections);
}

const MAX_MOMENTS = 5;
const MAX_MESSAGE_CHARS = 200;

function clamp(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= MAX_MESSAGE_CHARS
    ? oneLine
    : oneLine.slice(0, MAX_MESSAGE_CHARS - 1) + '…';
}

function detectSalience(distilled: LegacyDistilled): SalientMoment[] {
  const moments: SalientMoment[] = [];
  const seen = new Set<string>();

  const push = (message: string, salience: 1 | 2 | 3): void => {
    const clamped = clamp(message);
    if (!clamped) return;
    const key = `${salience}::${clamped.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    moments.push({ message: clamped, salience });
  };

  for (const msg of distilled.userMessages) {
    if (isSystemNoiseMessage(msg)) continue;
    if (CORRECTION_RE.test(msg)) push(`User correction: ${msg}`, 2);
  }

  if (distilled.errors.length > 0 && distilled.codeChanges.length > 0) {
    push(`Error resolved by code change: ${distilled.errors[0]}`, 1);
  }

  const decisionSources = [
    ...distilled.agentDecisions.filter((d) => !d.startsWith('[thinking]')),
    ...distilled.userMessages,
  ];
  for (const src of decisionSources) {
    if (isSystemNoiseMessage(src)) continue;
    if (DECISION_RE.test(src)) push(`Decision: ${src}`, 2);
  }

  return moments.slice(0, MAX_MOMENTS);
}

/**
 * The SessionStart catch-up capture @7eca3421 (hook.ts lines 1762-1778): the main
 * transcript and every sub-agent transcript distilled, merged, then mined. No
 * spawned-session skip and no sub-agent brief exclusion existed then.
 */
export function legacyCaptureMoments(loc: TranscriptLocation): SalientMoment[] {
  if (!loc.mainPath) return [];
  const merged = mergeDistilled([distillTranscript(loc.mainPath), distillSubagents(loc)]);
  return detectSalience(merged);
}
