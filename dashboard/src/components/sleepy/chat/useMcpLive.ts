import { useEffect, useReducer } from 'react';
import type { McpChatAuth, McpChatStatus } from '../chatSession';
import { useClaudeAccounts } from '../../../hooks/useAgentCapabilities';

/** What the MCP surfaces need of a chat session (ChatSession satisfies it). */
export interface McpHost {
  mcp: McpChatStatus | null;
  mcpAuth: McpChatAuth;
  mcpVersion: number;
  mcpConnect: (name: string) => void;
  mcpReconnect: (name: string) => void;
  mcpRefresh: () => void;
  subscribe: (cb: () => void) => () => void;
  getModel: () => { activeAccountId?: string };
  readonly accountId: string;
}

/** The host when this session has the MCP channel (a chat session), else null. */
export function asMcpHost(session: object | null | undefined): McpHost | null {
  return session && typeof (session as Partial<McpHost>).mcpConnect === 'function' ? session as McpHost : null;
}

/**
 * The chat's live MCP state for one component: re-renders only when the MCP part changed
 * (`session.mcpVersion`), not on every streamed token the session's subscribers also hear.
 */
export function useMcpLive(session?: McpHost | null): { status: McpChatStatus | null; auth: McpChatAuth } {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    if (!session) return undefined;
    let seen = session.mcpVersion;
    return session.subscribe(() => {
      if (session.mcpVersion !== seen) { seen = session.mcpVersion; bump(); }
    });
  }, [session]);
  return { status: session?.mcp ?? null, auth: session?.mcpAuth ?? {} };
}

/**
 * The email of the Claude account this chat runs on, '' when unknown. Named on the MCP card and
 * the popover because a browser sign-in may land in whichever account the browser is signed
 * into, and the owner has to know which one the CLI expects.
 */
export function useChatAccountEmail(session?: McpHost | null): string {
  const { data } = useClaudeAccounts(!!session);
  if (!session || !data) return '';
  const id = session.getModel().activeAccountId || session.accountId;
  const acc = id ? data.accounts.find((a) => a.id === id) : data.accounts.find((a) => a.isPrimary) ?? null;
  return acc?.email ?? '';
}
