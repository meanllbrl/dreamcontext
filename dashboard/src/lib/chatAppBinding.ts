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

let fileSession = '';

/** The conversation on screen in an app's frame: its own folders open files with no grant. */
export function setFileSession(claudeId: string): void {
  fileSession = claudeId;
}

/** `&session=<id>` in an app's frame, '' everywhere else, so the main app's file URLs stay as they are. */
export function fileSessionParam(): string {
  return fileSession ? `&session=${encodeURIComponent(fileSession)}` : '';
}

/** The URL fragment of an app's socket, '' for every other chat, whose URL stays byte-for-byte. */
export function appChatParam(claudeId: string): string {
  const b = bindings.get(claudeId);
  if (!b) return '';
  return `&app=${encodeURIComponent(b.slug)}&tk=${encodeURIComponent(b.tk)}${b.member ? `&member=${encodeURIComponent(b.member)}` : ''}`;
}
