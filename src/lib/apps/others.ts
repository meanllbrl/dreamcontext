/**
 * What the Apps page shows beside this Mac's registered apps (plan-veri r3, K5):
 *  - a TEAM NOTE: `knowledge/apps/<x>.md` with `app: <slug>` that no app here is registered as.
 *    A teammate's app: its knowledge came with the brain, its data and code did not.
 *  - ORPHAN DATA: `_dream_context/apps/<slug>/` with no app registered: a removed app's data.
 * Read-only, lstat + realpath contained, slugs through APP_SLUG_RE, titles plain text.
 */

import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { APP_SLUG_RE } from './bundle.js';
import { appsDataRoot, contextRootOf } from './data-dir.js';

export type AppOther =
  | { kind: 'team-note'; slug: string; title: string; note: string; knowledgeId: string }
  | { kind: 'orphan-data'; slug: string; dataPath: string };

const MAX_NOTES = 200;

function realInside(root: string, p: string): boolean {
  try {
    const r = relative(realpathSync.native(root), realpathSync.native(p));
    return r !== '' && !r.startsWith('..') && !isAbsolute(r);
  } catch { return false; }
}

function plain(v: unknown, max: number): string {
  // eslint-disable-next-line no-control-regex
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function frontmatter(text: string): Record<string, unknown> | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  try { const v = parseYaml(m[1]) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

export function appOthers(projectRoot: string, registered: ReadonlySet<string>): AppOther[] {
  const contextRoot = contextRootOf(projectRoot);
  const out: AppOther[] = [];
  const noteDir = join(contextRoot, 'knowledge', 'apps');
  const seen = new Set<string>();
  let names: string[] = [];
  try { names = readdirSync(noteDir).filter((n) => n.endsWith('.md')).sort().slice(0, MAX_NOTES); } catch { /* none */ }
  for (const name of names) {
    const p = join(noteDir, name);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isFile() || st.size > 64 * 1024 || !realInside(contextRoot, p)) continue;
      const fm = frontmatter(readFileSync(p, 'utf-8'));
      const slug = typeof fm?.app === 'string' ? fm.app : '';
      if (!APP_SLUG_RE.test(slug) || registered.has(slug) || seen.has(slug)) continue;
      seen.add(slug);
      const title = plain(fm?.title, 80) || plain(fm?.name, 80) || slug;
      out.push({ kind: 'team-note', slug, title, note: `_dream_context/knowledge/apps/${name}`, knowledgeId: `apps/${name.slice(0, -3)}` });
    } catch { /* unreadable: not listed */ }
  }
  const dataRoot = appsDataRoot(projectRoot);
  let dirs: string[] = [];
  try { dirs = readdirSync(dataRoot).sort(); } catch { /* none */ }
  for (const slug of dirs) {
    if (!APP_SLUG_RE.test(slug) || registered.has(slug)) continue;
    const p = join(dataRoot, slug);
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory() || !realInside(contextRoot, p)) continue;
      out.push({ kind: 'orphan-data', slug, dataPath: `_dream_context/apps/${slug}` });
    } catch { /* gone */ }
  }
  return out;
}
