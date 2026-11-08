import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildCorpus, bm25Search } from '../../src/lib/recall.js';
import { rewriteWikilinks } from '../../src/lib/wikilink-rewrite.js';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';
import { appOthers } from '../../src/lib/apps/others.js';

/** plan-veri r3 K3, AC7: no automatic reader of the brain walks into app data. */
let base: string; let project: string; let ctx: string; let data: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-readers-')));
  project = join(base, 'proj');
  ctx = join(project, '_dream_context');
  mkdirSync(join(ctx, 'knowledge'), { recursive: true });
  data = ensureAppDataDir(project, 'yuk');
  writeFileSync(join(data, 'notes.md'), '---\nname: zebracorn ledger\n---\nzebracorn customer ACME owes [[old-note]]\n');
  writeFileSync(join(ctx, 'knowledge', 'a.md'), '---\nname: a\n---\nsee [[old-note]] about hippogriff\n');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('readers of the brain', () => {
  it('recall never finds a .md inside app data', () => {
    const corpus = buildCorpus(ctx);
    expect(corpus.some((d) => d.path.includes(`${join('_dream_context', 'apps')}`))).toBe(false);
    expect(bm25Search('zebracorn', corpus, 5)).toEqual([]);
    expect(bm25Search('hippogriff', corpus, 5).length).toBeGreaterThan(0);
  });

  it('a wikilink rename rewrites the brain and leaves app data byte for byte', () => {
    const before = readFileSync(join(data, 'notes.md'), 'utf-8');
    const changed = rewriteWikilinks(ctx, [{ from: 'old-note', to: 'new-note' }]);
    expect(changed).toEqual([join(ctx, 'knowledge', 'a.md')]);
    expect(readFileSync(join(data, 'notes.md'), 'utf-8')).toBe(before);
  });

  it('every `**` glob rooted at contextRoot in src/ ignores apps/**', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(resolve('src'));
    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf-8');
      const re = /fg(?:\.sync|\.async|\.stream)?\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*"|`[^`]*`)\s*,\s*\{([^}]*)\}/g;
      for (const m of text.matchAll(re)) {
        const [, pattern, opts] = m;
        if (!/cwd:\s*contextRoot\b/.test(opts) || !pattern.includes('**')) continue;
        if (!/'apps\/\*\*'/.test(opts)) offenders.push(`${f}: fg(${pattern}, {${opts.trim()}})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('the Apps page list beside the apps', () => {
  it('a teammate\'s note (no app here) and a removed app\'s data, nothing for registered apps, no symlink', () => {
    mkdirSync(join(ctx, 'knowledge', 'apps'), { recursive: true });
    writeFileSync(join(ctx, 'knowledge', 'apps', 'crm.md'), '---\napp: crm\ntitle: "CRM <b>panel</b>"\nsource: app:crm\n---\n');
    writeFileSync(join(ctx, 'knowledge', 'apps', 'yuk.md'), '---\napp: yuk\n---\n');
    writeFileSync(join(ctx, 'knowledge', 'apps', 'bad.md'), '---\napp: "../x"\n---\n');
    ensureAppDataDir(project, 'old-app');
    mkdirSync(join(ctx, 'apps', '.yuk.restoring-ab12'));
    const others = appOthers(project, new Set(['yuk']));
    expect(others).toEqual([
      { kind: 'team-note', slug: 'crm', title: 'CRM b panel /b', note: '_dream_context/knowledge/apps/crm.md', knowledgeId: 'apps/crm' },
      { kind: 'orphan-data', slug: 'old-app', dataPath: '_dream_context/apps/old-app' },
    ]);
  });
});
