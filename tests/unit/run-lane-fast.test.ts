import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { FAST_DONE_LINE, FAST_LANE_MAX_LINES, fastRefusal, laneFromGit, pickLane, type ChangedFile } from '../../src/lib/run-lane.js';

/**
 * The fast gate (plan sirket-yavaslik D1, contract C1, AC1): synthetic fixtures only. Every one
 * that shows, hides or changes money must stay out of fast.
 */
const tsx = (path: string, plus: string[], opts: { minus?: string[]; whole?: string; added?: boolean } = {}): ChangedFile => ({
  path, lines: plus.length + (opts.minus?.length ?? 0), after: opts.whole ?? plus.join('\n'), plus, minus: opts.minus ?? [], ...(opts.added ? { added: true } : {}),
});
const json = (path: string, before: unknown, after: unknown): ChangedFile => {
  const a = JSON.stringify(after, null, 1);
  return { path, lines: 2, before: JSON.stringify(before, null, 1), after: a, plus: [a], minus: [] };
};
const lane = (files: ChangedFile[]) => pickLane(files, 'fast');

describe('fast: look and copy changes take it', () => {
  it('a CSS colour', () => {
    expect(lane([tsx('src/screens/Step3.module.css', ['.cta { background: #2e7d32; }'], { minus: ['.cta { background: #888; }'] })]).lane).toBe('fast');
  });
  it('a visual variant prop', () => {
    expect(lane([tsx('src/screens/Step3.tsx', ['<Button variant="primary">Devam</Button>'])]).lane).toBe('fast');
  });
  it('a tsx with an effect elsewhere whose changed line is only a className', () => {
    const whole = 'useEffect(() => { load(); }, []);\nreturn <div className="card big" />;';
    expect(lane([tsx('src/screens/Step3.tsx', ['return <div className="card big" />;'], { whole, minus: ['return <div className="card" />;'] })]).lane).toBe('fast');
  });
  it('plain copy in a locales JSON', () => {
    expect(lane([json('src/locales/tr/step3.json', { step3: { title: 'Hoş geldin' } }, { step3: { title: 'Merhaba' } })]).lane).toBe('fast');
  });
  it('a funnel screen that tracks elsewhere, its changed line a className', () => {
    const whole = 'track("step3_view");\nreturn <h1 className="title xl">Adım 3</h1>;';
    expect(lane([tsx('src/funnel/Step3.tsx', ['return <h1 className="title xl">Adım 3</h1>;'], { whole })]).lane).toBe('fast');
  });
  it('an unchanged dangerouslySetInnerHTML next to a className change', () => {
    const whole = '<div dangerouslySetInnerHTML={{ __html: body }} />\n<p className="lead" />';
    expect(lane([tsx('src/screens/Info.tsx', ['<p className="lead" />'], { whole })]).lane).toBe('fast');
  });
  it('nothing changed yet is fast and visible (a reproduction still gets its shot)', () => {
    expect(lane([])).toMatchObject({ lane: 'fast', visible: true });
  });
  it('prints the owner\'s line', () => {
    expect(FAST_DONE_LINE).toContain("'tam doğrula'");
  });
});

describe('fast: money never takes it (C1)', () => {
  const cases: Array<[string, ChangedFile]> = [
    ['a weekly price under a paywall key', json('src/locales/tr/plans.json', { paywall: { weekly: '₺99,99/hafta' } }, { paywall: { weekly: '₺149,99/hafta' } })],
    ['a free trial line', tsx('src/screens/Offer.tsx', ['<p>3 gün ücretsiz deneme</p>'])],
    ['a renewal line', tsx('src/screens/Offer.tsx', ['<small>İptal etmediğiniz sürece yenilenir</small>'])],
    ['{plan.weekly} to {plan.monthly} with no other money word', tsx('src/screens/Card.tsx', ['<b>{plan.monthly}</b>'], { minus: ['<b>{plan.weekly}</b>'] })],
    ['a paywall CSS colour', tsx('src/paywall/Paywall.module.css', ['.btn{color:red}'])],
    ['an SVG with a price in it', tsx('src/assets/badge.svg', ['<text>₺149,99</text>'])],
    ['renewal terms hidden on a subscription path', tsx('src/subscription/terms.css', ['.renewal-terms{display:none}'])],
    ['an entitlement read', tsx('src/screens/Home.tsx', ['{entitlements.active.pro && <Badge />}'])],
    ['a deleted subscription line, no other money word', tsx('src/screens/Footer.tsx', [], { minus: ['<p>Abonelik otomatik yenilenir.</p>'], whole: '<footer />' })],
    ['a hidden cancel note', tsx('src/screens/Footer.css', ['.cancel-note{display:none}'])],
    ['a shown dollar amount', tsx('src/screens/Footer.tsx', ['<p>Only $9.99</p>'])],
    ['an A/B assignment', tsx('src/screens/Hero.tsx', ['const v = getVariant("hero");'])],
  ];
  it.each(cases)('%s', (_name, f) => {
    const p = lane([f]);
    expect(p.lane).not.toBe('fast');
    expect(p.reason).toMatch(/fast refused/);
  });
  it('the reason names money and the file', () => {
    expect(lane([tsx('src/screens/Offer.tsx', ['<p>Yıllık fiyat</p>'])]).reason).toMatch(/fast refused \(money: fiyat in src\/screens\/Offer\.tsx\)/);
  });
});

describe('fast: logic and ways out of the page never take it', () => {
  const cases: Array<[string, ChangedFile]> = [
    ['fetch( in a changed line', tsx('src/screens/Step3.tsx', ['const r = await fetch("/api/x");'])],
    ['a URL value in a changed JSON leaf', json('src/locales/tr/links.json', { help: 'Yardım' }, { help: 'https://evil.example/x' })],
    ['an added dangerouslySetInnerHTML', tsx('src/screens/Info.tsx', ['<div dangerouslySetInnerHTML={{ __html: x }} />'])],
    ['a script src in html', tsx('public/index.html', ['<script src="/x.js"></script>'])],
    ['an outside image', tsx('src/screens/Hero.tsx', ['<img src="https://cdn.example/a.png" />'])],
    ['onload= in an SVG', tsx('src/assets/logo.svg', ['<svg onload="x()"></svg>'])],
    ['an unquoted event attribute', tsx('src/screens/A.html', ['<img onerror=alert(1)>'])],
    ['a new import line', tsx('src/screens/Hero.tsx', ["import { x } from './y';"])],
    ['a track( call in the changed line', tsx('src/funnel/Step3.tsx', ['onShow={() => track("x")}'])],
  ];
  it.each(cases)('%s', (_name, f) => {
    expect(lane([f]).lane).not.toBe('fast');
  });
});

describe('fast: what the gate cannot read or does not own', () => {
  it('no recorded intent: never fast', () => {
    expect(pickLane([tsx('src/a.css', ['.a{}'])]).lane).toBe('light');
    expect(pickLane([tsx('src/a.css', ['.a{}'])], null).lane).toBe('light');
  });
  it('a recorded full is full, whatever the diff', () => {
    expect(pickLane([tsx('src/a.css', ['.a{}'])], 'full').lane).toBe('full');
  });
  it(`${FAST_LANE_MAX_LINES + 1} lines is no fast change`, () => {
    expect(lane([{ ...tsx('src/a.css', ['.a{}']), lines: FAST_LANE_MAX_LINES + 1 }]).lane).not.toBe('fast');
  });
  it('a deleted file, an added tsx, a .ts file, unread content', () => {
    expect(fastRefusal([{ path: 'src/a.css', lines: 3, deleted: true }])).toMatch(/deletes/);
    expect(fastRefusal([tsx('src/New.tsx', ['<p/>'], { added: true })])).toMatch(/adds/);
    expect(fastRefusal([tsx('src/util.ts', ['x'])])).toMatch(/not a look or copy file/);
    expect(fastRefusal([{ path: 'src/a.css', lines: 1 }])).toMatch(/could not read/);
  });
  it('an instruction .md is no copy file; a plain .md is, and is not visible', () => {
    expect(fastRefusal([tsx('AGENTS.md', ['x'])])).not.toBeNull();
    const p = lane([tsx('docs/notes.md', ['Bir not'])]);
    expect(p).toMatchObject({ lane: 'fast', visible: false });
  });
  it('an added image is fine', () => {
    expect(lane([{ path: 'src/assets/hero.png', lines: 0, added: true }]).lane).toBe('fast');
  });
});

describe('laneFromGit with a fast intent reads the real diff', () => {
  let repo: string;
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, encoding: 'utf-8' }).trim();
  const write = (p: string, text: string) => { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), text); };
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'lane-fast-'));
    git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@e.st'); git('config', 'user.name', 't');
    write('src/Step.tsx', 'useEffect(() => {}, []);\nexport function S() {\n  return (\n    <div className="a" />\n  );\n}\n');
    write('src/locales/tr/s.json', '{"s":{"title":"Selam"}}\n');
    git('add', '-A'); git('commit', '-qm', 'base');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('a className-only change in a file with an effect is fast', () => {
    const base = git('rev-parse', 'HEAD');
    write('src/Step.tsx', 'useEffect(() => {}, []);\nexport function S() {\n  return (\n    <div className="a big" />\n  );\n}\n');
    expect(laneFromGit(repo, base, undefined, 'fast').lane).toBe('fast');
  });
  it('a price added in copy is not', () => {
    const base = git('rev-parse', 'HEAD');
    write('src/locales/tr/s.json', '{"s":{"title":"Selam, sadece ₺49,99"}}\n');
    expect(laneFromGit(repo, base, undefined, 'fast').lane).not.toBe('fast');
  });
  it('a deleted subscription sentence in a committed change is not', () => {
    write('src/Footer.tsx', 'export const F = () => <p>Abonelik yenilenir</p>;\n');
    git('add', '-A'); git('commit', '-qm', 'footer');
    const base = git('rev-parse', 'HEAD');
    write('src/Footer.tsx', 'export const F = () => <p />;\n');
    git('add', '-A'); git('commit', '-qm', 'drop');
    expect(laneFromGit(repo, base, 'HEAD', 'fast').lane).not.toBe('fast');
  });
});
