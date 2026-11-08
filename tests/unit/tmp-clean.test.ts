import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  cleanAllVaultTmps, cleanTmp, cleanTmpIfDue, extractTmpRefs, readLastClean, tmpSize,
  TMP_CLEAN_INTERVAL_MS, TMP_CLEAN_LOG, TMP_TTL_MS,
} from '../../src/lib/tmp-clean.js';

const DAY = 24 * 60 * 60 * 1000;
// Each file's mtime is set relative to NOW; NOW sits 30 days ahead so no clock edge matters.
const NOW = Date.now() + 30 * DAY;

let base: string;
let project: string;
let ctx: string;
let tmp: string;

function put(rel: string, body = 'x', ageMs = 20 * DAY): string {
  const abs = join(tmp, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  const t = (NOW - ageMs) / 1000;
  utimesSync(abs, t, t);
  return abs;
}
function brain(rel: string, body: string): void {
  const abs = join(ctx, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'tmp-clean-test-'));
  project = join(base, 'proj');
  ctx = join(project, '_dream_context');
  tmp = join(ctx, 'tmp');
  mkdirSync(tmp, { recursive: true });
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('tmp clean', () => {
  it('removes an unlinked file past 14 days, keeps one touched since, and removes the folder it emptied', () => {
    const old = put('reports/old.html', 'abcdef');
    const fresh = put('reports2/new.html', 'y', 2 * DAY);
    const r = cleanTmp(ctx, { now: NOW });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(tmp, 'reports'))).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(r.deleted).toEqual([{ path: 'reports/old.html', bytes: 6 }]);
    expect(r.bytes).toBe(6);
    expect(r.kept.recent).toBe(1);
    expect(r.dirsRemoved).toContain('reports');
    expect(readFileSync(join(tmp, TMP_CLEAN_LOG), 'utf-8')).toMatch(/\t6\treports\/old\.html\n$/);
  });

  it('keeps a file a task links and every file of a folder knowledge links, whatever their age', () => {
    const linkedFile = put('super/a/shot.png');
    const inFolder1 = put('mockups/v1/a.html');
    const inFolder2 = put('mockups/v1/deep/b.png');
    const other = put('mockups/v2/c.html');
    brain('state/some-task.md', 'Evidence: ![shot](_dream_context/tmp/super/a/shot.png).\n');
    brain('knowledge/design.md', 'The board lives in `tmp/mockups/v1/`.\n');
    const r = cleanTmp(ctx, { now: NOW });
    expect(existsSync(linkedFile)).toBe(true);
    expect(existsSync(inFolder1)).toBe(true);
    expect(existsSync(inFolder2)).toBe(true);
    expect(existsSync(other)).toBe(false);
    expect(r.kept.linked).toBe(3);
  });

  it('keeps what the Super stage shows: a card ref and a pending ask preview picture', () => {
    const card = put('super/report/rapor.html');
    const preview = put('asks/option-a.png');
    const gone = put('super/other/rapor.html');
    brain('state/.super-agent.json', JSON.stringify({
      containers: [{ kind: 'web', ref: '_dream_context/tmp/super/report/rapor.html' }],
      queue: [{ kind: 'ask', state: 'open', questions: [{ options: [{ label: 'A', preview: '<img src="tmp/asks/option-a.png">' }] }] }],
      children: {},
    }));
    cleanTmp(ctx, { now: NOW });
    expect(existsSync(card)).toBe(true);
    expect(existsSync(preview)).toBe(true);
    expect(existsSync(gone)).toBe(false);
  });

  it("keeps a live Super child's brief folder and drops an ended child's", () => {
    const liveBrief = put('super-prompts/tmp-temizlik/brief.md');
    const endedBrief = put('super-prompts/old-job/brief.md');
    brain('state/.super-agent.json', JSON.stringify({
      children: {
        a: { sessionId: 'a', branch: 'super/tmp-temizlik', row: 'working' },
        b: { sessionId: 'b', branch: 'super/old-job', endedAt: 1 },
      },
    }));
    const r = cleanTmp(ctx, { now: NOW });
    expect(existsSync(liveBrief)).toBe(true);
    expect(existsSync(endedBrief)).toBe(false);
    expect(r.kept.live).toBe(1);
  });

  it('never follows or removes a symlink, in tmp or as tmp', () => {
    const outside = join(base, 'outside');
    mkdirSync(outside);
    const victim = join(outside, 'keep.txt');
    writeFileSync(victim, 'mine');
    const t = (NOW - 40 * DAY) / 1000;
    utimesSync(victim, t, t);
    symlinkSync(outside, join(tmp, 'linkdir'));
    symlinkSync(victim, join(tmp, 'linkfile'));
    const r = cleanTmp(ctx, { now: NOW });
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(join(tmp, 'linkdir'))).toBe(true);
    expect(r.kept.symlink).toBe(2);
    expect(r.deleted).toEqual([]);

    // tmp itself a symlink: refused whole.
    const p2 = join(base, 'p2', '_dream_context');
    mkdirSync(p2, { recursive: true });
    symlinkSync(outside, join(p2, 'tmp'));
    expect(cleanTmp(p2, { now: NOW }).skipped).toBe('symlink');
    expect(existsSync(victim)).toBe(true);
  });

  it('a template path names nothing, and agent-drops is left to its own rule', () => {
    const brief = put('super-prompts/x/brief.md');
    const drop = put('agent-drops/photo.png');
    brain('knowledge/how.md', 'Briefs go to `_dream_context/tmp/super-prompts/<slug>/brief.md`.\n');
    cleanTmp(ctx, { now: NOW });
    expect(existsSync(brief)).toBe(false);
    expect(existsSync(drop)).toBe(true);
    // An OS /tmp mention is read too: reading too much only keeps more.
    expect(extractTmpRefs('see /tmp/os-file and tmp/a/b.png, then `tmp/c/`')).toEqual(['os-file', 'a/b.png', 'c/']);
    expect(extractTmpRefs('`tmp/super-prompts/{slug}/x` and tmp/<slug> and $tmp/$SLUG')).toEqual([]);
  });

  it('reads every way a record writes a tmp link: relative, bold, Windows, a stand-in inside a name', () => {
    const rel = put('super-sonuclar/ajanda-not/02-A.png');
    const bold = put('bold/x.txt');
    const win = put('win/a.html');
    const bracket = put('shots/shot[1].png');
    const esc = put('json/option a.png');
    const gone = put('other/z.txt');
    brain('state/assets/some-task/outcome.md', '![A](../../../tmp/super-sonuclar/ajanda-not/02-A.png)\n**tmp/bold/x.txt**\n');
    brain('knowledge/win.md', 'Saved to C:\\proj\\_dream_context\\tmp\\win\\a.html and tmp/shots/shot[1].png\n');
    brain('state/.super-agent.json', JSON.stringify({ queue: [{ preview: '<img src="tmp/json/option a.png">' }] }));
    brain('state/assets/some-task/run.sh', 'cp out.png ../tmp/run-out.png\n');
    const script = put('run-out.png');
    cleanTmp(ctx, { now: NOW });
    for (const f of [rel, bold, win, bracket, esc, script]) expect(existsSync(f)).toBe(true);
    expect(existsSync(gone)).toBe(false);
  });

  it('removes nothing when a records folder cannot be read, and keeps a git checkout inside tmp whole', () => {
    const old = put('a/old.txt');
    mkdirSync(join(ctx, 'knowledge'), { recursive: true });
    const locked = join(ctx, 'knowledge', 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    try {
      const r = cleanTmp(ctx, { now: NOW });
      expect(r.skipped).toBe('unreadable-records');
      expect(existsSync(old)).toBe(true);
    } finally {
      chmodSync(locked, 0o755);
    }
    const repoFile = put('checkout/src/a.ts');
    mkdirSync(join(tmp, 'checkout', '.git'));
    const r = cleanTmp(ctx, { now: NOW });
    expect(existsSync(repoFile)).toBe(true);
    expect(r.kept.repo).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  it('keeps an old-dated file that landed in a folder touched since (moved or cp -p in)', () => {
    const moved = put('landed/old-dated.mov');
    const t = (NOW - 1 * DAY) / 1000;
    utimesSync(join(tmp, 'landed'), t, t);
    const r = cleanTmp(ctx, { now: NOW });
    expect(existsSync(moved)).toBe(true);
    expect(r.kept.recent).toBe(1);
  });

  it('a records root that is a symlink is not read and stops the clean', () => {
    const old = put('a/old.txt');
    const elsewhere = join(base, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(ctx, 'people'));
    expect(cleanTmp(ctx, { now: NOW }).skipped).toBe('unreadable-records');
    expect(existsSync(old)).toBe(true);
  });

  it('a dry run lists and measures but removes and writes nothing', () => {
    const old = put('a/old.bin', '12345');
    const r = cleanTmpIfDue(ctx, { now: NOW, dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.deleted).toEqual([{ path: 'a/old.bin', bytes: 5 }]);
    expect(existsSync(old)).toBe(true);
    expect(existsSync(join(tmp, TMP_CLEAN_LOG))).toBe(false);
    expect(readLastClean(ctx)).toBeNull();
  });

  it('runs at most once a day per vault', () => {
    put('a/one.txt');
    const first = cleanTmpIfDue(ctx, { now: NOW });
    expect(first.deleted).toHaveLength(1);
    expect(readLastClean(ctx)).toBe(NOW);
    const second = put('a/two.txt', 'x', 20 * DAY);
    const again = cleanTmpIfDue(ctx, { now: NOW + TMP_CLEAN_INTERVAL_MS - 1 });
    expect(again.skipped).toBe('not-due');
    expect(existsSync(second)).toBe(true);
    const nextDay = cleanTmpIfDue(ctx, { now: NOW + TMP_CLEAN_INTERVAL_MS });
    expect(nextDay.deleted.map((d) => d.path)).toEqual(['a/two.txt']);
  });

  it("cleans every registered vault from an injected home, and tmpSize measures without following links", () => {
    const home = join(base, 'home');
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'vaults.json'), JSON.stringify({ vaults: [{ name: 'p', path: project }] }));
    put('x/old.txt', 'abc');
    put('x/new.txt', 'ab', DAY);
    expect(tmpSize(ctx)).toEqual({ bytes: 5, files: 2 });
    const lines: string[] = [];
    const out = cleanAllVaultTmps({ home, now: NOW, log: (l) => lines.push(l) });
    expect(out).toHaveLength(1);
    expect(out[0].deleted.map((d) => d.path)).toEqual(['x/old.txt']);
    expect(lines.join('\n')).toMatch(/removed 1 file/);
    expect(TMP_TTL_MS).toBe(14 * DAY);
  });
});
