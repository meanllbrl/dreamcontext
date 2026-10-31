/**
 * The bridge child's entry (`dreamcontext t3-chat`). Built as its OWN bundle (dist/t3-bridge.js,
 * tsup.config.ts) so Effect and the vendored T3 layer never load with the main CLI: every Claude
 * hook starts dist/index.js, and must not pay to parse them.
 */
import { join } from 'node:path';
import { tabWantsAgentTitle } from '../chat-tab-title-nudge.js';
import { ecoJoins } from './eco.js';
import { codexCachedModels, codexDefaultModel } from './registry.js';
import { runBridgeStdio } from './stdio.js';

export interface T3ChatOptions {
  tool: 'codex' | 'claude';
  cwd: string;
  model?: string;
  effort?: string;
  mode: string;
  pane?: string;
  resume?: string;
  briefingFile?: string;
  extraRoot?: string[];
}

export async function runT3Chat(o: T3ChatOptions): Promise<number> {
  const eco = ecoJoins(o.cwd, process.env, { tool: o.tool });
  return runBridgeStdio(
    {
      tool: o.tool,
      cwd: o.cwd,
      // No model asked for: the account's own default, else the first model Codex cached for it.
      model: o.model || (o.tool === 'claude' ? 'sonnet' : codexDefaultModel() || codexCachedModels()[0]?.id || 'gpt-5.5'),
      ...(o.effort ? { effort: o.effort } : {}),
      mode: o.mode,
      paneId: o.pane ?? '',
      ...(o.resume ? { resume: o.resume } : {}),
      ...(o.briefingFile ? { briefingFile: o.briefingFile } : {}),
      extraRoots: o.extraRoot ?? [],
    },
    {
      input: process.stdin,
      write: (line) => { process.stdout.write(line); },
      env: process.env,
      handleSignals: true,
      tabWantsTitle: () => process.env.DREAMCONTEXT_CHAT_TAB === '1' && tabWantsAgentTitle(process.env, join(o.cwd, '_dream_context')),
      onReady: (id) => eco.onReady(id),
      onRotated: (id) => eco.onRotated(id),
      onResult: (session) => eco.onResult(session.nativeThreadId, session.wire.contextTokens),
    },
  );
}
