/**
 * Which tool a hook process is printing for (Track T W3): set once by `hook … --format codex`,
 * read by the snapshot's per-tool ceiling and the prompt hook. Process memory, never the
 * environment: a hook's children (a background sleep, a headless Claude run) must not inherit it,
 * or a Claude session would print for Codex.
 */
let tool: 'codex' | null = null;

export function setHookTool(t: 'codex' | null): void { tool = t; }
export function hookTool(): 'codex' | null { return tool; }
