import type { McpConnectState, McpHome, McpLiveServer } from '../../../lib/mcpWire';

/**
 * Pure helpers the `/mcp` popover and the `mcp` chat card share (task mcp-management): what a
 * row says, which button it offers, the order rows come in, and the one report a card sends.
 * Everything here reads the redacted live status (`McpLiveServer`) — names, statuses, where a
 * server lives — and nothing else exists on this side to read.
 */

/** The claude.ai page where a connector is managed (it cannot be edited locally). */
export const CLAUDE_AI_CONNECTORS_URL = 'https://claude.ai/settings/connectors';

/** A server only the owner can bring back: it needs a sign-in, or it failed. */
export function needsYou(s: Pick<McpLiveServer, 'status'>): boolean {
  return s.status === 'needs-auth' || s.status === 'failed';
}

const RANK: Record<string, number> = { 'needs-auth': 0, failed: 1, pending: 2, unknown: 3, disabled: 4, connected: 5 };

/** Needs-you first (sign-in before failed), then connecting, then the rest, by name. */
export function sortNeedsYouFirst<T extends Pick<McpLiveServer, 'status' | 'name'>>(servers: readonly T[]): T[] {
  return [...servers].sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3) || a.name.localeCompare(b.name));
}

/** Where a server lives, the way a row's second line says it. */
export function homeLabel(home: McpHome): string {
  switch (home) {
    case 'computer': return 'on this computer';
    case 'project': return 'this project';
    case 'team': return 'team (.mcp.json)';
    case 'claudeai': return 'claude.ai connector';
    case 'plugin': return 'plugin';
    case 'app': return 'added by the app';
    case 'outside': return 'found outside dreamcontext';
  }
}

/** The status half of a row's second line. */
export function statusLabel(s: McpLiveServer): string {
  switch (s.status) {
    case 'connected': return s.toolCount !== undefined ? `${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : 'connected';
    case 'needs-auth': return s.home === 'claudeai' ? 'expired' : 'sign-in needed';
    case 'pending': return 'connecting…';
    case 'disabled': return 'turned off';
    case 'failed':
      switch (s.errorKind) {
        case 'spawn': return 'failed to start';
        case 'auth': return 'sign-in rejected';
        case 'timeout': return 'timed out';
        case 'protocol': return 'did not answer properly';
        default: return 'failed';
      }
    default: return 'unknown';
  }
}

export type McpRowAction = 'connect' | 'reconnect' | 'restart' | null;

/**
 * The one button a row offers. A server that needs a sign-in gets Connect (a claude.ai
 * connector: Reconnect); a FAILED one gets Restart (`mcp_reconnect`), never a sign-in — a
 * failed stdio server cannot be signed into, and offering it was the old panel's dead button.
 */
export function rowAction(s: Pick<McpLiveServer, 'status' | 'home'>): McpRowAction {
  if (s.status === 'needs-auth') return s.home === 'claudeai' ? 'reconnect' : 'connect';
  if (s.status === 'failed') return 'restart';
  return null;
}

export function actionLabel(a: Exclude<McpRowAction, null>): string {
  return a === 'connect' ? 'Connect' : a === 'reconnect' ? 'Reconnect' : 'Restart';
}

/** What a connect in flight says on its row, or null when there is none. */
export function connectLabel(state: McpConnectState | undefined, host?: string): string | null {
  switch (state) {
    case 'opening': return host ? `opening ${host}…` : 'opening the browser…';
    case 'waiting': return host ? `finish signing in on ${host}` : 'finish signing in in the browser';
    case 'timeout': return 'sign-in didn\'t complete';
    case 'failed': return 'could not start the sign-in';
    case 'busy': return 'another sign-in is running';
    default: return null;
  }
}

/** A name the card wrote, matched to a live row: exactly, else ignoring case. */
export function findServer(name: string, servers: readonly McpLiveServer[]): McpLiveServer | null {
  return servers.find((s) => s.name === name)
    ?? servers.find((s) => s.name.toLowerCase() === name.toLowerCase())
    ?? null;
}

/** Every named server is live and connected. */
export function allConnected(names: readonly string[], servers: readonly McpLiveServer[]): boolean {
  return names.length > 0 && names.every((n) => findServer(n, servers)?.status === 'connected');
}

/**
 * The card's one report back to the agent. The first line names EVERY server the card asked
 * for, so the Super Agent's owner-wait (`answeredBy`) can tell which card it answers.
 */
export function mcpReport(kind: 'connected' | 'skipped', names: readonly string[], servers: readonly McpLiveServer[] = []): string {
  const head = `MCP ${kind}: ${names.join(', ')}`;
  if (kind === 'connected') return head;
  const ok = names.filter((n) => findServer(n, servers)?.status === 'connected');
  const not = names.filter((n) => !ok.includes(n));
  return `${head}\nThe owner chose to continue without: ${not.join(', ') || 'none'}.${ok.length ? ` Connected: ${ok.join(', ')}.` : ''}`;
}

/** localStorage key that remembers a card already reported (a reload must not report twice). */
export function reportedKey(conversationId: string | undefined, cardId: string): string {
  return `dc-mcp-card-reported:${conversationId ?? ''}:${cardId}`;
}

/** The card's memory between readings: did it ever see a named server broken, and did it
 *  already report. */
export interface CardReportState { sawBroken: boolean; reported: 'connected' | 'skipped' | null }

/**
 * One reading in, the card's next state and whether to send `MCP connected: …` now. A card
 * reports at most once, and on its own only after it saw a named server broken (a transcript
 * re-read later, all green, is not an owner finishing a sign-in).
 */
export function nextCardReport(
  prev: CardReportState, names: readonly string[], servers: readonly McpLiveServer[],
): { state: CardReportState; send: 'connected' | null } {
  const broken = names.some((n) => {
    const s = findServer(n, servers);
    return !!s && s.status !== 'connected' && s.status !== 'pending';
  });
  const sawBroken = prev.sawBroken || broken;
  if (prev.reported || !sawBroken || !allConnected(names, servers)) return { state: { ...prev, sawBroken }, send: null };
  return { state: { sawBroken, reported: 'connected' }, send: 'connected' };
}

/** ↑/↓ in the popover: wraps; any other key keeps the index. */
export function nextIndex(index: number, length: number, key: string): number {
  if (!length) return 0;
  if (key === 'ArrowDown') return (index + 1) % length;
  if (key === 'ArrowUp') return (index + length - 1) % length;
  return Math.min(index, length - 1);
}
