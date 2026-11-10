/**
 * One spelling per call, so the item the owner saw, the grant written from it and the call the
 * enforcer checks compare as equal strings. Bash is the command trimmed and nothing else: any
 * further normalising would let two different commands share one grant.
 */

/** Shell tools: the command is what the owner reads and what a grant names. Codex's names are
 *  shells too, but their command may be an argv array, which has no single honest spelling. */
export const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'shell', 'exec_command']);

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : stable(x)));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) if (o[k] !== undefined) out[k] = stable(o[k]);
    return out;
  }
  return v === undefined ? null : v;
}

export function stableJson(v: unknown): string {
  return JSON.stringify(stable(v)) ?? 'null';
}

/**
 * The call's canonical input. A string handed in is a stored canonical form (an item keeps that):
 * for Bash the command itself, for another tool its JSON, re-spelled stably so both ways agree.
 */
export function canonicalInput(tool: string, input: unknown): string {
  if (tool === 'Bash') {
    if (typeof input === 'string') return input.trim();
    const cmd = input && typeof input === 'object' ? (input as Record<string, unknown>).command : undefined;
    if (typeof cmd === 'string') return cmd.trim();
  }
  if (typeof input === 'string') {
    try { return stableJson(JSON.parse(input)); } catch { return stableJson(input); }
  }
  return stableJson(input);
}

/**
 * The input as a record, whether the caller holds the raw tool input or a stored canonical
 * string (an item keeps the canonical form): the guards read fields like `file_path`.
 */
export function inputRecord(tool: string, input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    if (tool === 'Bash') return { command: input };
    try {
      const v: unknown = JSON.parse(input);
      return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
    } catch { return {}; }
  }
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
}
