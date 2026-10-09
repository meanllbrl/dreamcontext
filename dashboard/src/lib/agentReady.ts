/**
 * Can a Claude session spawn on this machine at all?
 *
 * This is the agent surface's FULL guard (AgentSurface.tsx: `caps.desktop && caps.claudeCli
 * && claudeReady && agentSettings.enabled`, with `claudeReady = chatMode ||
 * (caps.embeddedTerminal && caps.claudeCli)` and `chatMode = chatView && claudeCli`) lifted
 * into one pure function, so the onboarding hand-off asks exactly the question the surface
 * will ask when it receives the start request. A "Start with Claude" button that the surface
 * then refuses would read as a dead button.
 */
export interface AgentSpawnInputs {
  /** The server hosts agents here (the desktop app, loopback). */
  desktop: boolean;
  /** The `claude` CLI is runnable (on the shell, or in a known install folder). */
  claudeCli: boolean;
  /** Settings → Agents: the Chat screen is the chosen surface. */
  chatView: boolean;
  /** The in-app terminal can render (desktop + node-pty, not Windows). */
  embeddedTerminal: boolean;
  /** Settings → Agents: the agent surface is switched on. */
  enabled: boolean;
}

export function agentCanSpawn(a: AgentSpawnInputs): boolean {
  const chatMode = a.chatView && a.claudeCli;
  const claudeReady = chatMode || (a.embeddedTerminal && a.claudeCli);
  return a.desktop && a.claudeCli && claudeReady && a.enabled;
}
