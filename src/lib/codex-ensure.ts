import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CODEX_MIN_VERSION, codexHealth, compareVersions, managedCodexRoot, managedCodexVersion } from './codex-bin.js';
import { CODEX_PIN } from './codex-pin.js';

/**
 * Does an update owe this machine a Codex? Missing, not starting, older than dreamcontext was run
 * against, or a managed one behind the pin. A healthy install of the user's owes nothing.
 */
export function codexEnsureNeeded(home: string = homedir()): boolean {
  const h = codexHealth({ home });
  if (!h.runs || !h.version || compareVersions(h.version, CODEX_MIN_VERSION) < 0) return true;
  const managed = managedCodexVersion(home);
  return !!managed && compareVersions(managed, CODEX_PIN.version) < 0;
}

const stampFile = (home: string): string => join(managedCodexRoot(home), 'ensured.json');

/** The dreamcontext version that last made sure of Codex: a new version asks once, not every start. */
export function codexEnsuredFor(home: string = homedir()): string | null {
  try { return (JSON.parse(readFileSync(stampFile(home), 'utf-8')) as { version?: string }).version ?? null; } catch { return null; }
}

export function markCodexEnsured(version: string, home: string = homedir()): void {
  try {
    mkdirSync(dirname(stampFile(home)), { recursive: true });
    writeFileSync(stampFile(home), JSON.stringify({ version }) + '\n');
  } catch { /* asked again next start */ }
}
