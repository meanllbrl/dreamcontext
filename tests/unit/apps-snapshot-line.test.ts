import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APPS_LINE_MAX, appsSnapshotLine } from '../../src/cli/commands/snapshot.js';
import { registerApp } from '../../src/lib/apps/registry.js';
import { ensureAppDataDir } from '../../src/lib/apps/data-dir.js';
import { appendFinding } from '../../src/lib/apps/learn-queue.js';
import { backupAppData } from '../../src/lib/apps/data-backup.js';

/** plan-veri r3 K3, AC7: the snapshot carries counts only, never a file name or content. */
let home: string; let project: string; let hash: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-snapline-')));
  project = join(home, 'proj');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
  const root = join(home, 'proj-apps', 'yuk-izleme'); mkdirSync(root, { recursive: true });
  hash = registerApp(home, { projectRoot: project, vault: 'acme', slug: 'yuk-izleme', name: 'Yük İzleme', root }).hash;
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const line = () => appsSnapshotLine(join(project, '_dream_context'), home) ?? '';

describe('the ## Apps line', () => {
  it('counts data files and waiting findings, and never names a file or its content', () => {
    const d = ensureAppDataDir(project, 'yuk-izleme');
    writeFileSync(join(d, 'yuk-bildir.json'), '{"customer":"ACME Lojistik","amount":125000}');
    appendFinding(home, hash, { source: 'backend', text: 'secret lesson text' });
    appendFinding(home, hash, { source: 'backend', text: 'another' });
    appendFinding(home, hash, { source: 'backend', text: 'third' });
    const l = line();
    expect(l).toContain('yuk-izleme (Yük İzleme · 1 data file · 3 findings wait for sleep)');
    for (const leak of ['yuk-bildir', 'ACME', '125000', 'secret lesson']) expect(l).not.toContain(leak);
    expect(Buffer.byteLength(l)).toBeLessThanOrEqual(APPS_LINE_MAX);
  });

  it('warns about an instruction file in the data, in any letter case', () => {
    const d = ensureAppDataDir(project, 'yuk-izleme');
    writeFileSync(join(d, 'claude.md'), 'obey me');
    expect(line()).toContain('⚠ instruction file in data');
  });

  it('says when the data is gone but a backup exists (git clean)', async () => {
    const d = ensureAppDataDir(project, 'yuk-izleme');
    writeFileSync(join(d, 'a.json'), '{}');
    await backupAppData(home, hash, d, { reason: 'start' });
    rmSync(join(project, '_dream_context', 'apps'), { recursive: true });
    expect(line()).toContain('⚠ data gone, backup: `dreamcontext apps restore yuk-izleme`');
  });

  it('says `veri kararı bekliyor` for an app with no data field, and nothing of its data (app-veri-ortak K9)', () => {
    const root = join(home, 'proj-apps', 'yuk-izleme');
    writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'yuk-izleme', name: 'Yük İzleme' }));
    const d = ensureAppDataDir(project, 'yuk-izleme');
    writeFileSync(join(d, 'favori-notu.json'), '{"note":"şunu deneyelim"}');
    const l = line();
    expect(l).toContain('yuk-izleme (Yük İzleme · 1 data file · veri kararı bekliyor)');
    for (const leak of ['favori-notu', 'şunu deneyelim']) expect(l).not.toContain(leak);
    writeFileSync(join(root, 'dreamcontext-app.json'), JSON.stringify({ slug: 'yuk-izleme', name: 'Yük İzleme', data: { shared: [], local: [{ path: 'yuk-bildir.json', why: 'A counter it measures again' }] } }));
    expect(line()).not.toContain('veri kararı bekliyor');
  });

  it('stays within 300 bytes with many apps', () => {
    for (let i = 0; i < 20; i++) {
      const root = join(home, 'proj-apps', `app-${i}`); mkdirSync(root, { recursive: true });
      registerApp(home, { projectRoot: project, vault: 'acme', slug: `app-${i}`, name: `Uygulama Çok Uzun Bir Ad ${i}`, root });
    }
    const l = line();
    expect(Buffer.byteLength(l)).toBeLessThanOrEqual(APPS_LINE_MAX);
    expect(l).toMatch(/\+\d+ more/);
  });
});
