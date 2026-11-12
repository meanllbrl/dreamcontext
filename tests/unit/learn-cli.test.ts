import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  learn,
  learnImport,
  learnDrop,
  learnKeep,
  learnList,
  learnStats,
  learnUndo,
  type LearnContext,
  type LearnFlags,
} from '../../src/cli/commands/learn.js';
import type { OwnerTurnLine } from '../../src/lib/owner-words.js';
import {
  LEARNED_RULES_VIEW_REL,
  RULES_JSON_REL,
  deriveRule,
  personalStoreRef,
  projectStoreRef,
  readStore,
  rulePhrases,
  supersedeFlags,
  type RuleView,
} from '../../src/lib/rules-store.js';

/**
 * `dreamcontext learn` (C1, criterion 1; G1 rows of criterion 3; the unit half of criterion 14).
 * Synthetic throughout: the project is Orchard, the people Robin and Sam; never real words.
 */

let tmp: string;
let home: string;
let project: string;
let root: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dc-learn-'));
  home = join(tmp, 'home');
  project = join(tmp, 'orchard');
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
  mkdirSync(join(root, 'knowledge', 'patterns'), { recursive: true });
  mkdirSync(home, { recursive: true });
  sleeping();
});

/** A sleep holds the vault's lock (`sleep start`), so `--by sleep` is accepted. */
function sleeping(): void {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', '.sleep.json'), JSON.stringify({ sleep_started_at: new Date(NOW.getTime() - 60_000).toISOString() }));
}
function unsleep(): void {
  writeFileSync(join(root, 'state', '.sleep.json'), JSON.stringify({ sleep_started_at: null }));
}
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const SUPER_ENV = { CLAUDE_CODE_SESSION_ID: 'sess-super-1', DREAMCONTEXT_TAB_SESSION: 'tab-super' };
const SUPER_KEYS = ['pin-super', 'tab-super', 'sess-super-1'];
const CHILD_ENV = { CLAUDE_CODE_SESSION_ID: 'sess-child', DREAMCONTEXT_TAB_SESSION: 'tab-child' };
const LINT_OWN = 'Please always run the linter before you push to the Orchard repo.';
const LINT_QUOTE = 'always run the linter before you push';

let seq = 0;
function turn(own: string, over: Partial<OwnerTurnLine> = {}): OwnerTurnLine {
  seq += 1;
  return {
    at: `2026-11-0${Math.min(9, 1 + (seq % 8))}T09:00:00.000Z`,
    turn: `turn-${seq}`,
    vault: project,
    surface: 'super',
    via: 'composer',
    keys: SUPER_KEYS,
    session: 'sess-super-1',
    own,
    ...over,
  };
}

const NOW = new Date('2026-11-10T12:00:00.000Z');
function ctx(env: Record<string, string>, turns: OwnerTurnLine[], over: Partial<LearnContext> = {}): LearnContext {
  return { contextRoot: root, home, env, now: NOW, turns, gitEmail: 'robin@orchard.test', ...over };
}

function run(text: string, flags: LearnFlags, c: LearnContext) {
  return learn(text, flags, c);
}

function projectRule(id: string): RuleView {
  const rec = readStore(projectStoreRef(root, home)).rules.find((r) => r.id === id)!;
  return deriveRule(rec, NOW);
}

describe('learn: scopes and the receipt (criterion 1)', () => {
  it('scope project writes the vault store with both receipt lines', () => {
    const r = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [turn(LINT_OWN)]));
    expect(r.code).toBe(0);
    expect(r.lines[0]).toMatch(/^LEARNED [a-z2-7]{10} active project$/);
    expect(r.lines[1]).toBe('Kaydedildi: "Run the linter before every push" · bu projenin kuralları · yanlışsa "geri al" de');
    expect(existsSync(join(root, RULES_JSON_REL))).toBe(true);
    expect(readFileSync(join(root, LEARNED_RULES_VIEW_REL), 'utf-8')).toContain('Run the linter before every push');
  });

  it('scope me writes the personal store, creating me.json from git user.email', () => {
    const own = 'From now on write every chart title in Turkish for me.';
    const r = run('Chart titles in Turkish', { scope: 'me', quote: ['write every chart title in Turkish'] }, ctx(SUPER_ENV, [turn(own)]));
    expect(r.lines[0]).toMatch(/^LEARNED [a-z2-7]{10} active me$/);
    expect(r.lines[1]).toContain('senin tercihlerin, her projede');
    expect(readStore(personalStoreRef(home)).rules).toHaveLength(1);
    expect(existsSync(join(root, RULES_JSON_REL))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, '.dreamcontext', 'me', 'me.json'), 'utf-8')).emails).toEqual(['robin@orchard.test']);
  });

  it('scope me with no me.json and no git email is refused with the reason', () => {
    const r = run('Chart titles in Turkish', { scope: 'me', quote: ['x y z'] }, ctx(SUPER_ENV, [], { gitEmail: null }));
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/no personal store/);
  });

  it('scope member delegates to automations learn and writes no record', () => {
    const calls: Array<[string, string]> = [];
    const r = run('Check the feed before posting', { scope: 'member', member: 'scout' }, ctx(SUPER_ENV, [], {
      delegateMember: (slug, lesson) => { calls.push([slug, lesson]); return 0; },
    }));
    expect(r.code).toBe(0);
    expect(calls).toEqual([['scout', 'Check the feed before posting']]);
    expect(existsSync(join(root, RULES_JSON_REL))).toBe(false);
  });

  it('the app chat gets the same two lines: no card hint until the card ships (W2)', () => {
    const r = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx({ ...SUPER_ENV, DREAMCONTEXT_CHAT_TAB: '1' }, [turn(LINT_OWN)]));
    expect(r.lines).toHaveLength(2);
    expect(r.lines.join('\n')).not.toContain('"type":"learned"');
  });
});

describe('learn: idempotency (criterion 1)', () => {
  it('the same call twice changes nothing', () => {
    const c = ctx(SUPER_ENV, [turn(LINT_OWN)]);
    const a = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, c);
    const before = readFileSync(join(root, RULES_JSON_REL), 'utf-8');
    const b = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, c);
    expect(b.id).toBe(a.id);
    expect(b.lines.slice(0, 2)).toEqual(a.lines.slice(0, 2));
    expect(readFileSync(join(root, RULES_JSON_REL), 'utf-8')).toBe(before);
  });

  it('two different rules citing one sentence are two records', () => {
    const own = 'Write the changelog in plain words and keep every entry short.';
    const c = ctx(SUPER_ENV, [turn(own)]);
    const a = run('Changelog in plain words', { scope: 'project', quote: ['Write the changelog in plain words'] }, c);
    const b = run('Keep changelog entries short', { scope: 'project', quote: ['keep every entry short'] }, c);
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.id).not.toBe(b.id);
    expect(readStore(projectStoreRef(root, home)).rules).toHaveLength(2);
  });

  it('a child-forwarded line plus the Super\'s learn of the same saying: one record, repeats 0', () => {
    const turns = [turn(LINT_OWN)];
    const child = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(CHILD_ENV, turns));
    expect(child.status).toBe('proposed');
    const sup = run('Run the linter before each push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, turns));
    expect(sup.id).toBe(child.id);
    expect(readStore(projectStoreRef(root, home)).rules).toHaveLength(1);
    const v = projectRule(child.id!);
    expect(v.repeats).toBe(0);
    expect(v.status).toBe('active');
  });

  it('a near-twin with no --same, --replaces or --new is refused with the candidates', () => {
    const first = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [turn(LINT_OWN)]));
    const later = turn('Run the linter before each push to the repo, I keep saying it.', { session: 'sess-super-2' });
    const r = run('Run the linter before each push to the repo', { scope: 'project', quote: ['Run the linter before each push to the repo'] }, ctx(SUPER_ENV, [turn(LINT_OWN), later]));
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/--same <id>.*--replaces <id>.*--new/);
    expect(r.lines.join('\n')).toContain(first.id!);
  });
});

describe('learn --same: occasions and repeats (criterion 1)', () => {
  const first = turn(LINT_OWN, { session: 'sess-a' });

  it('another occasion: repeats 1, hot, quote added as a phrase', () => {
    const a = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [first]));
    const again = turn('I said it before: run the linter before you push, always.', { session: 'sess-b' });
    const r = run('Run the linter before every push', { scope: 'project', same: a.id, quote: ['run the linter before you push, always'] }, ctx(SUPER_ENV, [first, again]));
    expect(r.code).toBe(0);
    const v = projectRule(a.id!);
    expect(v.repeats).toBe(1);
    expect(v.hot).toBe(true);
    expect(rulePhrases(v)).toContain('run the linter before you push, always');
  });

  it('the Super\'s one pane after its session rotated, and Telegram in a later session: repeats count', () => {
    const a = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [first]));
    // Same pin, same tab id, a new live session.
    const rotated = turn(LINT_OWN, { session: 'sess-rotated' });
    run('Run the linter before every push', { scope: 'project', same: a.id, quote: [LINT_QUOTE] }, ctx({ ...SUPER_ENV, CLAUDE_CODE_SESSION_ID: 'sess-rotated' }, [first, rotated]));
    expect(projectRule(a.id!).repeats).toBe(1);
    const tg = turn('Always run the linter before you push, from my phone.', { via: 'telegram', session: 'sess-later' });
    run('Run the linter before every push', { scope: 'project', same: a.id, quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [first, rotated, tg]));
    expect(projectRule(a.id!).repeats).toBe(2);
  });

  it('a second turn of the occasion that created it: the saying is added, repeats 0, not hot', () => {
    const a = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [first]));
    const sameSitting = turn('Again, run the linter before you push.', { session: 'sess-a' });
    run('Run the linter before every push', { scope: 'project', same: a.id, quote: ['run the linter before you push'] }, ctx(SUPER_ENV, [first, sameSitting]));
    const v = projectRule(a.id!);
    expect(v.sayings).toHaveLength(2);
    expect(v.repeats).toBe(0);
    expect(v.hot).toBe(false);
  });

  it('a saying with no ledger turn (a terminal) never raises repeats', () => {
    const a = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [first]));
    run('Run the linter before every push', { scope: 'project', same: a.id, quote: ['lint before you push it'] }, ctx({}, [first]));
    expect(projectRule(a.id!).repeats).toBe(0);
  });
});

describe('learn --replaces, undo, sleep after undo, --supersedes (criterion 1)', () => {
  it('replaces: the old rule is superseded and the receipt names it; undo restores it once', () => {
    const t1 = turn(LINT_OWN);
    const a = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [t1]));
    const t2 = turn('Actually run lint and the unit tests before every push from now on.');
    const b = run('Run lint and unit tests before every push', { scope: 'project', replaces: a.id, quote: ['run lint and the unit tests before every push'] }, ctx(SUPER_ENV, [t1, t2]));
    expect(b.lines[1]).toContain('eskisi saklandı: "Run the linter before every push"');
    expect(projectRule(a.id!).status).toBe('superseded');
    const u = learnUndo(b.id!, ctx(SUPER_ENV, [t1, t2]));
    expect(u.code).toBe(0);
    expect(projectRule(a.id!).status).toBe('active');
    expect(projectRule(b.id!).status).toBe('undone');
    const again = learnUndo(b.id!, ctx(SUPER_ENV, [t1, t2]));
    expect(again.code).toBe(1);
    expect(again.lines[0]).toMatch(/already undone/);
  });

  it('replacing a PROPOSED rule, then undo: the old rule is proposed again, never active', () => {
    const t1 = turn(LINT_OWN);
    const a = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx({}, [t1]));
    expect(a.status).toBe('proposed');
    const t2 = turn('Actually run lint and the unit tests before every push from now on.');
    const b = run('Run lint and unit tests before every push', { scope: 'project', replaces: a.id, quote: ['run lint and the unit tests before every push'] }, ctx(SUPER_ENV, [t1, t2]));
    expect(b.status).toBe('active');
    const u = learnUndo(b.id!, ctx(SUPER_ENV, [t1, t2]));
    expect(u.code).toBe(0);
    expect(u.lines[1]).toContain('yine onayını bekliyor');
    expect(u.lines[1]).not.toContain('yeniden geçerli');
    expect(projectRule(a.id!).status).toBe('proposed');
    expect(learnList(ctx({}, [])).lines.join('\n')).toMatch(new RegExp(`${a.id}  proposed`));
    expect(readFileSync(join(root, LEARNED_RULES_VIEW_REL), 'utf-8').split('## Waiting for his word')[1]).toContain(a.id!);
  });

  it('--by sleep outside a sleep run is refused', () => {
    unsleep();
    const r = run('Weekly report on one page', { scope: 'project', by: 'sleep', quote: ['Keep the weekly report to one page'] }, ctx({}, [turn('Keep the weekly report to one page.')]));
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/no sleep is in progress/);
  });

  it('a later --by sleep citing an undone rule\'s sayings is refused, also reworded', () => {
    const t1 = turn('Never attach screenshots larger than two megabytes to a report.', { session: 's1' });
    const a = run('No screenshots over 2 MB in reports', { scope: 'project', quote: ['Never attach screenshots larger than two megabytes'] }, ctx(SUPER_ENV, [t1]));
    learnUndo(a.id!, ctx(SUPER_ENV, [t1]));
    const r = run('Keep report images small', { scope: 'project', by: 'sleep', new: true, quote: ['Never attach screenshots larger than two megabytes'] }, ctx({}, [t1]));
    expect(r.code).toBe(1);
    expect(r.lines[0]).toMatch(/he undid/);
  });

  it('--supersedes: flagged while the excerpt is in the file, not after', () => {
    const notes = join(root, 'knowledge', 'notes.md');
    writeFileSync(notes, '# Notes\n\nNever use the staging server for demos.\nOther line.\n');
    const t1 = turn('Use the staging server for every demo, it is fine now.');
    const r = run('Use the staging server for demos', { scope: 'project', quote: ['Use the staging server for every demo'], supersedes: ['knowledge/notes.md'] }, ctx(SUPER_ENV, [t1]));
    expect(r.code).toBe(0);
    expect(supersedeFlags(root, projectRule(r.id!)).map((f) => f.still)).toEqual([true]);
    expect(learnList(ctx(SUPER_ENV, [t1])).lines.join('\n')).toContain('old text still says the opposite');
    writeFileSync(notes, '# Notes\n\nOther line.\n');
    expect(supersedeFlags(root, projectRule(r.id!)).map((f) => f.still)).toEqual([false]);
  });

  it('--supersedes outside the vault is refused', () => {
    writeFileSync(join(tmp, 'outside.md'), 'Never use staging.');
    const r = run('Use staging for demos', { scope: 'project', quote: ['use staging for every demo'], supersedes: ['../../outside.md'] }, ctx(SUPER_ENV, []));
    expect(r.code).toBe(1);
  });

  it('an unparsable store is refused and the .bak is kept', () => {
    const c = ctx(SUPER_ENV, [turn(LINT_OWN), turn('Write the changelog in plain words, please.')]);
    run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, c);
    run('Changelog in plain words', { scope: 'project', quote: ['Write the changelog in plain words'] }, c);
    const file = join(root, RULES_JSON_REL);
    writeFileSync(file, '{"rules": [ broken');
    const r = run('Name files in kebab case', { scope: 'project', quote: ['name files in kebab case'], new: true }, c);
    expect(r.code).toBe(1);
    expect(r.lines.join('\n')).toContain('store unreadable');
    expect(readFileSync(file, 'utf-8')).toBe('{"rules": [ broken');
    expect(JSON.parse(readFileSync(`${file}.bak`, 'utf-8')).rules).toHaveLength(1);
  });

  it('text limits are refused at write', () => {
    const r = run('x', { scope: 'project', quote: [LINT_QUOTE], headline: 'h'.repeat(61) }, ctx(SUPER_ENV, [turn(LINT_OWN)]));
    expect(r.code).toBe(1);
    const tag = run('Do <b>this</b>', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [turn(LINT_OWN)]));
    expect(tag.code).toBe(1);
  });
});

describe('G1 (criterion 3, the learn half)', () => {
  it('a quote typed in this conversation is active, also after a resume and after its id rotated', () => {
    const t = turn(LINT_OWN);
    expect(run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [t])).status).toBe('active');
    // Rotated: only the tab id is shared.
    const rotated = run('Write the changelog in plain words', { scope: 'project', quote: ['write the changelog in plain words'] },
      ctx({ CLAUDE_CODE_SESSION_ID: 'sess-new', DREAMCONTEXT_TAB_SESSION: 'tab-super' }, [turn('Write the changelog in plain words, always.')]));
    expect(rotated.status).toBe('active');
  });

  it('a Codex pane: its thread id is a key', () => {
    const t = turn(LINT_OWN, { keys: ['th-codex', 'tab-codex'], session: 'th-codex' });
    const r = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx({ DREAMCONTEXT_AGENT_TOOL: 'codex', CODEX_THREAD_ID: 'th-codex' }, [t]));
    expect(r.status).toBe('active');
  });

  it('from a conversation with no ledger turn (a terminal): proposed', () => {
    const r = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx({}, [turn(LINT_OWN)]));
    expect(r.status).toBe('proposed');
    expect(r.lines[1]).toBe('Önerildi: "Run the linter before every push" · onaylarsan geçerli olur');
  });

  it('a quote that exists only in a child\'s brief (not in his own words): proposed', () => {
    const r = run('Ship on Fridays', { scope: 'project', quote: ['ship the release every Friday afternoon'] }, ctx(CHILD_ENV, [turn(LINT_OWN)]));
    expect(r.status).toBe('proposed');
  });

  it('--by sleep: one non-explicit quote proposed; two occasions active; one explicit turn active', () => {
    const one = [turn('Keep the weekly report to one page.', { session: 'o1' })];
    expect(run('Weekly report on one page', { scope: 'project', by: 'sleep', quote: ['Keep the weekly report to one page'] }, ctx({}, one)).status).toBe('proposed');
    const two = [turn('Name every branch after its task slug.', { session: 'o1' }), turn('Again: name every branch after its task slug.', { session: 'o2' })];
    expect(run('Branches named after task slugs', { scope: 'project', by: 'sleep', quote: ['Name every branch after its task slug', 'name every branch after its task slug'] }, ctx({}, two)).status).toBe('active');
    const explicit = [turn('bunu hatırla: deploy notlarını sade dille yaz', { session: 'o3' })];
    expect(run('Deploy notes in plain words', { scope: 'project', by: 'sleep', quote: ['deploy notlarını sade dille yaz'] }, ctx({}, explicit)).status).toBe('active');
  });

  it('a repeated sleep run over the same window, reworded: no new record, repeats unchanged', () => {
    const two = [turn('Name every branch after its task slug.', { session: 'o1' }), turn('Again: name every branch after its task slug.', { session: 'o2' })];
    const quotes = ['Name every branch after its task slug', 'name every branch after its task slug'];
    const a = run('Branches named after task slugs', { scope: 'project', by: 'sleep', new: true, quote: quotes }, ctx({}, two));
    const b = run('Name branches after the task slug', { scope: 'project', by: 'sleep', new: true, quote: quotes }, ctx({}, two));
    expect(b.id).toBe(a.id);
    expect(readStore(projectStoreRef(root, home)).rules).toHaveLength(1);
    expect(projectRule(a.id!).repeats).toBe(0);
  });

  it('keep: an agent needs his word about THAT rule, quoted from this chat', () => {
    const r = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx({}, [turn(LINT_OWN)]));
    expect(r.status).toBe('proposed');
    const later = '2026-11-10T12:30:00.000Z';
    // No quote: refused.
    expect(learnKeep(r.id!, ctx(SUPER_ENV, [turn(LINT_OWN)])).code).toBe(1);
    // An everyday "kısa tut" in an unrelated turn is not his word about this rule.
    const everyday = turn('Cevapları kısa tut lütfen, raporlar uzun oldu.', { at: later });
    expect(learnKeep(r.id!, ctx(SUPER_ENV, [everyday]), 'Cevapları kısa tut lütfen, raporlar uzun oldu').code).toBe(1);
    // Words he typed in ANOTHER conversation: refused.
    const elsewhere = turn('Tut: run the linter before every push kuralı kalsın.', { at: later, keys: ['other-chat'] });
    expect(learnKeep(r.id!, ctx(SUPER_ENV, [elsewhere]), 'run the linter before every push kuralı kalsın').code).toBe(1);
    // "tut" plus the rule's own words, typed here after the rule: kept.
    const here = turn('Tut: run the linter before every push kuralı kalsın.', { at: later });
    const kept = learnKeep(r.id!, ctx(SUPER_ENV, [everyday, here]), 'run the linter before every push kuralı kalsın');
    expect(kept.code).toBe(0);
    expect(kept.lines[0]).toMatch(/active project$/);
  });

  it('keep from his own shell needs no quote', () => {
    const r2 = run('Write the changelog in plain words', { scope: 'project', quote: ['write the changelog in plain words'] }, ctx({}, []));
    expect(learnKeep(r2.id!, ctx({}, [])).code).toBe(0);
  });

  it('drop: an agent needs his word about THAT rule too', () => {
    const r = run('Write the changelog in plain words', { scope: 'project', quote: ['write the changelog in plain words'] }, ctx({}, []));
    const later = '2026-11-10T12:30:00.000Z';
    const vague = turn('Hayır, bunu istemiyorum.', { at: later });
    expect(learnDrop(r.id!, ctx(SUPER_ENV, [vague]), 'Hayır, bunu istemiyorum').code).toBe(1);
    const named = turn('Changelog plain words kuralını istemiyorum, at gitsin.', { at: later });
    const d = learnDrop(r.id!, ctx(SUPER_ENV, [named]), 'Changelog plain words kuralını istemiyorum');
    expect(d.code).toBe(0);
    expect(projectRule(r.id!).status).toBe('undone');
  });
});

describe('privacy (criterion 14, unit half)', () => {
  it('a synced file holds only the redacted quote, never the rest of his turn', () => {
    const own = 'Run the linter before you push. Also the vendor token=abcdef1234567890xyz is private, and Sam is on leave.';
    run('Run the linter before every push', { scope: 'project', quote: ['run the linter before you push'] }, ctx(SUPER_ENV, [turn(own)]));
    run('Mind the vendor token', { scope: 'project', new: true, quote: ['the vendor token=abcdef1234567890xyz is private'] }, ctx(SUPER_ENV, [turn(own)]));
    for (const rel of [RULES_JSON_REL, LEARNED_RULES_VIEW_REL]) {
      const text = readFileSync(join(root, rel), 'utf-8');
      expect(text).not.toContain('Sam is on leave');
      expect(text).not.toContain('abcdef1234567890xyz');
    }
  });
});

describe('import and stats', () => {
  it('import writes ticked lines active and the rest proposed, by migration, once', () => {
    const items = [
      { scope: 'project', text: 'Name files in kebab case', ticked: true },
      { scope: 'project', text: 'Plain words in every report', quote: 'plain words in every report please' },
    ];
    expect(learnImport(items, ctx({}, [])).code).toBe(0);
    learnImport(items, ctx({}, []));
    const views = readStore(projectStoreRef(root, home)).rules.map((r) => deriveRule(r, NOW));
    expect(views).toHaveLength(2);
    expect(views.map((v) => v.status).sort()).toEqual(['active', 'proposed']);
    expect(views.every((v) => v.created.by === 'migration')).toBe(true);
  });

  it('stats counts this week\'s sayings of a stored rule', () => {
    const first = turn(LINT_OWN, { session: 'sa' });
    const a = run('Run the linter before every push', { scope: 'project', quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [first]));
    const again = turn('Always run the linter before you push, again.', { session: 'sb' });
    run('Run the linter before every push', { scope: 'project', same: a.id, quote: [LINT_QUOTE] }, ctx(SUPER_ENV, [first, again]));
    const s = learnStats(ctx({}, []), 1);
    expect(s.weeks[0]).toMatchObject({ sayings: 1, rules: 1, repeats: 1 });
    expect(s.lines.at(-1)).toMatch(/not measurable/);
  });
});
