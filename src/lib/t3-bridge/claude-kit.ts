/**
 * T3's Claude driver for the Claude engine setting (plan r5 §5), kept out of the Codex bridge:
 * it imports the Agent SDK, a real npm package the desktop app's `dist/` does not ship, so a
 * static import here would stop every Codex chat from loading in the packaged app. Only
 * `t3-bridge-claude.js` (main-claude.ts) pulls this in.
 */
import * as ClaudeAdapterV2 from '@t3tools/server/orchestration-v2/Adapters/ClaudeAdapterV2';
import * as PortScanner from '@t3tools/server/preview/PortScanner';

export const claudeKit = {
  make: ClaudeAdapterV2.makeClaudeAdapterV2,
  Runner: ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
  layerRunner: ClaudeAdapterV2.layerQueryRunner,
  layerPorts: PortScanner.layer,
  instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
  driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
};

export type ClaudeKit = typeof claudeKit;
