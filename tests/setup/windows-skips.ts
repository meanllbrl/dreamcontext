import { beforeEach } from 'vitest';
import { WINDOWS_SKIPS, type WindowsSkip } from '../windows-skip.js';

/**
 * The per-test half of tests/windows-skip.ts (whole files are excluded in vitest.config.ts).
 * On win32 only, a test whose file and "suite > … > name" match an entry is skipped, so the rest
 * of its file still runs there. Everywhere else this registers nothing.
 */

/** "suite > … > test", the name an entry's `test` is matched against. */
export function fullTestName(task: { name: string; suite?: { name: string; suite?: unknown } | null }): string {
  const names: string[] = [];
  let t: { name: string; suite?: unknown } | null | undefined = task;
  while (t) {
    if (t.name) names.unshift(t.name);
    t = (t as { suite?: { name: string; suite?: unknown } | null }).suite;
  }
  return names.join(' > ');
}

export function matchesSkip(entry: WindowsSkip, filepath: string, fullName: string): boolean {
  if (!entry.test) return false;
  return filepath.replace(/\\/g, '/').endsWith(entry.file) && fullName.includes(entry.test);
}

if (process.platform === 'win32') {
  const perTest = WINDOWS_SKIPS.filter((s) => s.test);
  beforeEach((ctx) => {
    const filepath = (ctx.task.file as { filepath?: string } | undefined)?.filepath ?? '';
    const name = fullTestName(ctx.task as never);
    if (perTest.some((s) => matchesSkip(s, filepath, name))) ctx.skip();
  });
}
