import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Let the agent session edit the app folder: `.claude/settings.local.json` additionalDirectories. */
export function allowAppDir(projectRoot: string, appRoot: string): void {
  const file = join(projectRoot, '.claude', 'settings.local.json');
  let cfg: Record<string, unknown> = {};
  try { cfg = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>; } catch { /* new file */ }
  const perms = (cfg.permissions && typeof cfg.permissions === 'object' ? cfg.permissions : {}) as Record<string, unknown>;
  const dirs = Array.isArray(perms.additionalDirectories) ? (perms.additionalDirectories as unknown[]).filter((d): d is string => typeof d === 'string') : [];
  if (!dirs.includes(appRoot)) dirs.push(appRoot);
  cfg.permissions = { ...perms, additionalDirectories: dirs };
  mkdirSync(join(projectRoot, '.claude'), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
}
