/**
 * The bridge child's entry (`dreamcontext t3-chat`). Built as its OWN bundle (dist/t3-bridge.js,
 * tsup.config.ts) so Effect and the vendored T3 layer never load with the main CLI: every Claude
 * hook starts dist/index.js, and must not pay to parse them.
 */
import { join } from 'node:path';
import { tabWantsAgentTitle } from '../chat-tab-title-nudge.js';
import { ecoJoins } from './eco.js';
import { BrainContext } from './context.js';
import { findCodexRollout } from './codex-threads.js';
import { codexCachedModels, codexDefaultModel } from './registry.js';
import { runBridgeStdio } from './stdio.js';
import type { BridgeSessionOptions } from './session.js';
import type { ClaudeKit } from './claude-kit.js';

export interface T3ChatOptions {
  tool: BridgeSessionOptions['tool'];
  cwd: string;
  model?: string;
  effort?: string;
  mode: string;
  pane?: string;
  resume?: string;
  briefingFile?: string;
  extraRoot?: string[];
  account?: string;
  carry?: string;
  mcpConfig?: string;
  strictMcp?: boolean;
}

export const runT3Chat = (o: T3ChatOptions): Promise<number> => runBridgeChat(o);
export { runT3Account } from './account-cli.js';
export { runT3Headless } from './run.js';

export async function runBridgeChat(o: T3ChatOptions, claudeKit?: ClaudeKit): Promise<number> {
  const eco = ecoJoins(o.cwd, process.env, { tool: o.tool, ...(o.account ? { accountId: o.account } : {}) });
  // The brain reaches Codex through our own hooks (context.ts). The T3 Claude engine (closed,
  // T3_CLAUDE_ENGINE_OPEN) would get it from Claude's own settings, so it gets none here.
  const brain = o.tool !== 'claude' ? new BrainContext({ cwd: o.cwd, env: process.env }) : null;
  return runBridgeStdio(
    {
      tool: o.tool,
      cwd: o.cwd,
      // No model asked for: the account's own default, else the first model Codex cached for it.
      model: o.model || (o.tool === 'antigravity' ? '' : o.tool === 'claude' ? 'sonnet' : codexDefaultModel() || codexCachedModels()[0]?.id || 'gpt-5.5'),
      ...(o.effort ? { effort: o.effort } : {}),
      mode: o.mode,
      paneId: o.pane ?? '',
      ...(o.resume ? { resume: o.resume } : {}),
      ...(o.briefingFile ? { briefingFile: o.briefingFile } : {}),
      extraRoots: o.extraRoot ?? [],
      ...(o.account ? { account: o.account } : {}),
      ...(o.carry ? { carry: o.carry } : {}),
      ...(o.mcpConfig ? { mcpConfig: o.mcpConfig } : {}),
      ...(o.strictMcp ? { strictMcp: true } : {}),
    },
    {
      ...(claudeKit ? { claudeKit } : {}),
      input: process.stdin,
      write: (line) => { process.stdout.write(line); },
      env: process.env,
      handleSignals: true,
      tabWantsTitle: () => process.env.DREAMCONTEXT_CHAT_TAB === '1' && tabWantsAgentTitle(process.env, join(o.cwd, '_dream_context')),
      onReady: (id) => eco.onReady(id),
      onRotated: (id) => eco.onRotated(id),
      onResult: (session, frame) => {
        // Sleep sees the turn: the Stop hook records it, the rollout as its transcript.
        brain?.turnEnded(session.nativeThreadId, o.tool === 'codex' ? findCodexRollout(session.nativeThreadId) : null, typeof frame.result === 'string' ? frame.result : '');
        return eco.onResult(session.nativeThreadId, session.wire.contextTokens);
      },
      ...(brain ? { brain } : {}),
    },
  );
}
