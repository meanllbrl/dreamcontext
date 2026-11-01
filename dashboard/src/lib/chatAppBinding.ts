/**
 * Which app a Chat conversation belongs to (plan r9): keyed by the conversation's UUID, like
 * `chatAgentBinding.ts`, so a reconnect or a respawn opens through the app gate again.
 */

export interface AppChatBinding {
  slug: string;
  tk: string;
  member: string | null;
}

const bindings = new Map<string, AppChatBinding>();

export function bindAppChat(claudeId: string, app: AppChatBinding): void {
  bindings.set(claudeId, app);
}

export function unbindAppChat(claudeId: string): void {
  bindings.delete(claudeId);
}

/** The URL fragment of an app's socket, '' for every other chat, whose URL stays byte-for-byte. */
export function appChatParam(claudeId: string): string {
  const b = bindings.get(claudeId);
  if (!b) return '';
  return `&app=${encodeURIComponent(b.slug)}&tk=${encodeURIComponent(b.tk)}${b.member ? `&member=${encodeURIComponent(b.member)}` : ''}`;
}
