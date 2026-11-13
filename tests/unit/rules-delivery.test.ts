import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureMeFile, newEventId, newRuleId, personalStoreRef, projectStoreRef, writeStore,
  type AtTag, type RuleEvent, type RuleRecord, type RuleScope,
} from '../../src/lib/rules-store.js';
import {
  DISPATCH_RULES_OPEN, actKind, actRefusal, appendToDispatch, deliverForTurn, foldLines, helperLines,
  momentLines, preferencesBlock, promptSurface,
} from '../../src/lib/rules-delivery.js';
import { firstActInSession } from '../../src/lib/hook-delivery.js';
import { HOOK_OUTPUT_MAX_CHARS } from '../../src/lib/snapshot-budget.js';

let tmp: string;
let home: string;
let ctx: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dc-rules-delivery-'));
  home = join(tmp, 'home');
  ctx = join(tmp, 'orchard', '_dream_context');
  mkdirSync(join(ctx, 'core'), { recursive: true });
  mkdirSync(join(ctx, 'knowledge', 'patterns'), { recursive: true });
  mkdirSync(home, { recursive: true });
  ensureMeFile(home, 'gardener@example.com');
});
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

const NOW = new Date('2026-11-05T10:00:00Z');
const T0 = '2026-11-02T09:00:00.000Z';

function rule(scope: RuleScope, headline: string, opts: { at?: AtTag; text?: string; status?: 'active' | 'proposed'; hot?: boolean } = {}): RuleRecord {
  const create: RuleEvent = {
    eid: newEventId(), at: T0, op: 'create', by: 'owner', conversation: 'c1', status: opts.status ?? 'active',
    headline, text: opts.text ?? headline, ...(opts.at ? { at_tag: opts.at } : {}),
    quotes: [{ text: headline.toLowerCase(), turn: `t-${headline.length}`, via: 'composer', occasion: 'o1' }],
  };
  const events: RuleEvent[] = [create];
  if (opts.hot) {
    events.push({ eid: newEventId(), at: '2026-11-04T09:00:00.000Z', op: 'same', by: 'owner', conversation: 'c2', quotes: [{ text: 'again', turn: 't-again', via: 'telegram', occasion: 'o2' }] });
  }
  return { id: newRuleId(), scope, created: { at: T0, by: 'owner', person: '' }, events };
}

function seed(me: RuleRecord[], project: RuleRecord[] = []): void {
  writeStore(personalStoreRef(home), { version: 1, rules: me });
  if (project.length) writeStore(projectStoreRef(ctx, home), { version: 1, rules: project });
}

describe('rules-delivery: session start (criterion 7 as replaced)', () => {
  it('every active rule of both stores is in the block with its id; proposed ones are named, not in force', () => {
    const a = rule('me', 'Write to him in plain Turkish', { at: 'always' });
    const b = rule('me', 'Numbers first in a report', { at: 'report' });
    const c = rule('project', 'Run the linter before a push');
    const p = rule('me', 'Ask before a paid run', { status: 'proposed' });
    seed([a, b, p], [c]);
    const block = preferencesBlock(ctx, { home, now: NOW })!;
    for (const r of [a, b, c]) expect(block).toContain(`[${r.id}`);
    expect(block).toContain('Write to him in plain Turkish');
    expect(block).toContain('this project');
    expect(block).toMatch(new RegExp(`Waiting for his word.*${p.id}`));
    expect(block.split('\n').filter((l) => l.includes(p.id))).toHaveLength(1);
  });

  it('nothing stored: no block; an unreadable store says so and never reads as empty', () => {
    expect(preferencesBlock(ctx, { home, now: NOW })).toBeNull();
    writeFileSync(join(ctx, 'core', 'RULES.json'), '{ not json');
    expect(preferencesBlock(ctx, { home, now: NOW })).toMatch(/project rules store is unreadable/);
  });

  it('60 active rules: all in the block; past its room the lightest fold into one "more" line, never cut mid-rule', () => {
    const many = Array.from({ length: 60 }, (_, i) => rule('me', `Rule number ${i} about how reports are written to him`));
    seed(many);
    const block = preferencesBlock(ctx, { home, now: NOW })!;
    for (const r of many) expect(block).toContain(r.id);
    const tight = preferencesBlock(ctx, { home, now: NOW, max: 700 })!;
    const lines = tight.split('\n').filter((l) => l.startsWith('- '));
    expect(lines.at(-1)).toMatch(/^- … \d+ more: `dreamcontext learn list`$/);
    for (const l of lines.slice(0, -1)) expect(l).toMatch(/\[[a-z2-7]{10}\]$/);
  });
});

describe('rules-delivery: by position (P1, sub-agent, dispatch)', () => {
  it('an owner turn gets always, hot and report/ask rules; a plain rule rides only at session start', () => {
    const a = rule('me', 'Plain Turkish, no jargon', { at: 'always' });
    const r = rule('me', 'Numbers first', { at: 'report' });
    const h = rule('project', 'Never merge without his word', { hot: true, text: 'Merge, push, tag only when he says so' });
    const plain = rule('project', 'Tests next to the code');
    seed([a, r], [h, plain]);
    const d = deliverForTurn(ctx, { surface: 'owner', prompt: 'durum nedir' }, { home, now: NOW });
    const text = momentLines(d)!;
    expect(text).toMatch(/^Before you answer him/);
    expect(text).toContain(a.id);
    expect(text).toContain(r.id);
    expect(text).toContain(`${h.id}, said again, this project]: Merge, push, tag only when he says so`);
    expect(text).not.toContain(plain.id);
    expect(d.matched).toEqual([]);
  });

  it('a sub-agent start and a dispatch carry every always and hot rule, not report ones', () => {
    const a = rule('me', 'Plain Turkish', { at: 'always' });
    const r = rule('me', 'Numbers first', { at: 'report' });
    const h = rule('me', 'Opus for sub-agents', { hot: true });
    seed([a, r, h]);
    const child = helperLines(deliverForTurn(ctx, { surface: 'child' }, { home, now: NOW }))!;
    expect(child).toContain(a.id);
    expect(child).toContain(h.id);
    expect(child).not.toContain(r.id);
    expect(child).toContain('dreamcontext learn list --me');
    const prompt = appendToDispatch('Find the bug', deliverForTurn(ctx, { surface: 'dispatch', tool_input: { prompt: 'Find the bug' } }, { home, now: NOW }))!;
    expect(prompt.startsWith('Find the bug\n\n<dreamcontext-owner-rules>')).toBe(true);
    expect(prompt).toContain(a.id);
    // Never appended twice (a re-dispatch of an already appended prompt).
    expect(appendToDispatch(prompt, deliverForTurn(ctx, { surface: 'dispatch' }, { home, now: NOW }))).toBeNull();
    expect(prompt.split(DISPATCH_RULES_OPEN)).toHaveLength(2);
  });

  it('60 always rules on a sub-agent start: every one while under the host limit', () => {
    seed(Array.from({ length: 60 }, (_, i) => rule('me', `Always rule ${i} for every helper agent`, { at: 'always' })));
    const d = deliverForTurn(ctx, { surface: 'child' }, { home, now: NOW, max: HOOK_OUTPUT_MAX_CHARS - 2_000 });
    expect(d.always.length + d.moment.length).toBe(60);
    expect([...d.always, ...d.moment].some((l) => l.includes('more:'))).toBe(false);
  });

  it('a machine turn gets nothing; a task notification is a finished-work event', () => {
    seed([rule('me', 'Numbers first', { at: 'report' })]);
    expect(promptSurface('<task-notification>done</task-notification>')).toBe('finished');
    expect(promptSurface('[super event] child finished')).toBe('finished');
    expect(promptSurface('bunu düzelt')).toBe('owner');
    expect(deliverForTurn(ctx, { surface: 'machine' }, { home, now: NOW }).chars).toBe(0);
    expect(momentLines(deliverForTurn(ctx, { surface: 'finished' }, { home, now: NOW }))).toContain('Numbers first');
  });

  it('a vault whose person shares no email with me.json gets no personal rule, and says so', () => {
    mkdirSync(join(ctx, 'people'), { recursive: true });
    writeFileSync(join(ctx, 'people', 'people.json'), JSON.stringify({ version: 1, people: { pat: { name: 'Pat', emails: ['pat@example.org'] } } }));
    process.env.DREAMCONTEXT_PERSON = 'pat';
    try {
      seed([rule('me', 'Plain Turkish', { at: 'always' })]);
      const d = deliverForTurn(ctx, { surface: 'child' }, { home, now: NOW });
      expect(helperLines(d)).toBeNull();
      expect(preferencesBlock(ctx, { home, now: NOW })).toMatch(/not shown here/);
    } finally { delete process.env.DREAMCONTEXT_PERSON; }
  });

  it('fold keeps whole lines and names the rest', () => {
    const out = foldLines(['- aaaa', '- bbbb', '- cccc'], 16, (n) => `+${n}`);
    expect(out).toEqual(['- aaaa', '+2']);
  });
});

describe('rules-delivery: before something that cannot be taken back (criterion 16)', () => {
  it('recognises the fixed list as tokens anywhere in the line, and nothing else', () => {
    const bash = (command: string) => actKind('Bash', { command });
    expect(bash('npm publish')).toBe('npm publish');
    expect(bash('cd pkg && npm publish --access public')).toBe('npm publish');
    expect(bash('git -C dir push origin main')).toBe('git push');
    expect(bash('git tag v1.2.0')).toBe('git tag');
    expect(bash('git tag -l')).toBeNull();
    expect(bash('gh release create v1')).toBe('gh release');
    expect(bash('gh release list')).toBeNull();
    expect(bash('gh pr merge 12 --squash')).toBe('gh pr merge');
    expect(bash('npm test')).toBeNull();
    expect(bash('git status')).toBeNull();
    // The act is the binary's own subcommand: never a word in a message or a later argument.
    expect(bash('git stash push -m wip')).toBeNull();
    expect(bash('git commit -m "feat: push notification permission"')).toBeNull();
    expect(bash('git add -A && git commit -m "fix push token refresh"')).toBeNull();
    expect(bash("git commit -m 'chore: npm publish notes; git push later'")).toBeNull();
    expect(bash('npm run publish-docs')).toBeNull();
    expect(bash('gh issue create --title "merge the pr"')).toBeNull();
    expect(bash('git add -A && git commit -m "x" && git push origin main')).toBe('git push');
    expect(bash('/usr/bin/git push')).toBe('git push');
    expect(bash('npm -w pkg publish')).toBe('npm publish');
    expect(bash('gh -R o/r pr merge 3')).toBe('gh pr merge');
    expect(bash('git -c user.name="A B" push')).toBe('git push');
    expect(bash('env X=1 git push')).toBe('git push');
    expect(bash('time git push')).toBe('git push');
    expect(bash('npm --access public publish')).toBe('npm publish');
    expect(bash('yarn npm publish')).toBe('npm publish');
    expect(actKind('mcp__slack__send_message', {})).toBe('send');
    expect(actKind('mcp__slack__read_channel', {})).toBeNull();
    expect(actKind('Read', { file_path: 'x' })).toBeNull();
  });

  it('npm publish opens the late section of an act pattern whole, not its title and not the lead', () => {
    writeFileSync(join(ctx, 'knowledge', 'patterns', 'release-checklist.md'), [
      '---', 'name: Release checklist', 'description: How a release goes out', 'at: act', '---', '',
      '# Release checklist', '', 'Lead text about the release train.', '',
      '## Build', '', 'Build the dashboard first.', '',
      '## Before npm publish', '', 'Run `npm whoami` and stop if it is not the owner account.', '',
    ].join('\n'));
    const r = rule('me', 'Ask him before anything goes out', { at: 'act' });
    seed([r]);
    const d = deliverForTurn(ctx, { surface: 'act', tool_name: 'Bash', tool_input: { command: 'npm publish' } }, { home, now: NOW });
    const reason = actRefusal('npm publish', d)!;
    expect(reason).toContain('## Before npm publish\n\nRun `npm whoami` and stop if it is not the owner account.');
    expect(reason).not.toContain('Lead text about the release train');
    expect(reason).toContain(r.id);
    expect(reason).toMatch(/run the same call again/);
  });

  it('an act rule about publishing does not stop a push; no act rule or pattern: nothing to refuse', () => {
    seed([rule('me', 'Run npm whoami before you publish', { at: 'act' })]);
    const push = deliverForTurn(ctx, { surface: 'act', tool_name: 'Bash', tool_input: { command: 'git push' } }, { home, now: NOW });
    expect(actRefusal('git push', push)).toBeNull();
    const pub = deliverForTurn(ctx, { surface: 'act', tool_name: 'Bash', tool_input: { command: 'npm publish' } }, { home, now: NOW });
    expect(actRefusal('npm publish', pub)).toContain('npm whoami');
  });

  it('stopped once per act and session; no session id never holds a call', () => {
    expect(firstActInSession('s-1', 'npm publish', home)).toBe(true);
    expect(firstActInSession('s-1', 'npm publish', home)).toBe(false);
    expect(firstActInSession('s-1', 'git push', home)).toBe(true);
    expect(firstActInSession('s-2', 'npm publish', home)).toBe(true);
    expect(firstActInSession('', 'npm publish', home)).toBe(false);
  });
});
