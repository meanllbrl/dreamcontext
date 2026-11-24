/** A due agent migration task's id, as a Super record keeps it (registry ids are kebab-case). */
export const MIGRATION_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/;
/** The most task ids one record field keeps. */
export const MAX_MIGRATION_IDS = 8;

/** Ids as a record keeps them: slug-shaped, unique, at most MAX_MIGRATION_IDS. Pure. */
export function cleanMigrationIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((x): x is string => typeof x === 'string' && MIGRATION_ID_RE.test(x)))].slice(0, MAX_MIGRATION_IDS);
}

/** One due agentTask as the CLI prints it: registry constants only. */
export interface DueMigration { version: string; id: string; title: string }

/** The event line's text (registry titles only). */
export function migrationEventLine(titles: readonly string[]): string {
  return `Migration work is waiting after an update: ${titles.join('; ')}. Start ONE child for it now: \`dreamcontext super delegate --migration\`. Tell the owner one line.`;
}

/** The child's first message: a constant, plus the due ids. Never the Super's words or vault text. */
export const MIGRATION_CHILD_PROMPT = "You are this project's migration session. Run `dreamcontext migrations pending` and do each task it prints. Anything that deletes, rebinds or re-approves the owner's things is asked in one card first. Record each task with the line it prints; if the owner says no, record it as declined.";
export function migrationChildPrompt(due: readonly DueMigration[]): string {
  return `${MIGRATION_CHILD_PROMPT}\n\nDue tasks: ${due.map((d) => `${d.version} ${d.id}`).join(', ')}.`;
}
export function migrationChildBrief(due: readonly DueMigration[]): string {
  return `Taşıma: ${due.map((d) => d.title).join('; ')}`;
}
