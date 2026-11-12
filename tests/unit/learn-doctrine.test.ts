/**
 * Doctrine in lockstep (learning-loop plan C8, C10, C5; criterion 12).
 *
 * 1. The old ban ("sleep never folds a correction into a pattern") is gone from every file that
 *    carried it, each in that file's OWN wording, so a reworded comeback in one file is caught.
 * 2. Every text an agent reads before it hears him carries the `learn` paragraph: when, the
 *    scopes, same or replaces by id, never stricter than his words, the receipt, never Claude's
 *    or Codex's own memory.
 * 3. The Super guide carries C10's two lines; sleep-product the opposite-instruction step;
 *    sleep-state the repeated-tool-error line.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_SURFACE_BRIEFING, SUPER_CHILD_BRIEFING } from '../../src/server/chat-surface.js';
import { SUPER_BRIEF_TEXT, memberSlotOf, superBriefing } from '../../src/server/chat-modes.js';
import { buildTurnLearningDirective } from '../../src/lib/automations/runner.js';
import { AGENTS_MD_BODY } from '../../src/lib/install-agents-md.js';
import { VIEW_TYPES } from '../../src/lib/chat-view-spec.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');
/** Prose wraps at any space: match a phrase across line breaks and indentation. */
const phrase = (s: string): RegExp => new RegExp(s.replace(/[.*+?^${}()|[\]\\`]/g, '\\$&').replace(/ /g, '\\s+'), 'i');

describe('C8: the ban is gone, in each file\'s own wording', () => {
  const BANS: Record<string, string[]> = {
    'agents/sleep-product.md': [
      'Never fold a user correction into a pattern',
      'that belongs to the awake agent in the task where it was said',
      'REPORTED as a missed awake rule',
    ],
    'skill/references/knowledge-and-recall.md': [
      'not a sleep chore',
      'Why it cannot wait for sleep',
      'which no longer folds corrections in',
    ],
    'skill/references/sleep-specialists.md': [
      'Pattern *content* is not yours to change on a user correction',
    ],
    'skill/references/sleep.md': [
      'Sleep does NOT fold user corrections into patterns',
      'REPORT it as a missed awake rule',
    ],
    // W1 L1 removes the hook comment; listed here so it cannot come back.
    'src/cli/commands/hook.ts': [
      'Folding the correction back in is therefore part of THIS task, not a sleep chore',
    ],
  };
  for (const [file, words] of Object.entries(BANS)) {
    it(`${file} no longer says it`, () => {
      const text = read(file);
      for (const w of words) expect(text, `${file}: "${w}"`).not.toMatch(phrase(w));
    });
  }

  it('no doctrine file says sleep does not fold or learn his corrections, in any wording', () => {
    const files = ['agents/sleep-product.md', 'agents/sleep-state.md', 'skill/references/knowledge-and-recall.md', 'skill/references/sleep-specialists.md'];
    for (const f of files) {
      expect(read(f), f).not.toMatch(/(never|not|no longer|does not|doesn't)\s+folds?\s+(a\s+|the\s+)?(user|owner)('s)?\s+corrections?/i);
      expect(read(f), f).not.toMatch(/Sleep does NOT fold/i);
    }
  });

  it('the October port is not back: no patterns learn, no owner-corrections ledger', () => {
    for (const f of ['agents/sleep-product.md', 'agents/sleep-state.md', 'skill/references/sleep-specialists.md', 'skill/references/knowledge-and-recall.md']) {
      expect(read(f), f).not.toContain('patterns learn');
      expect(read(f), f).not.toContain('patterns corrections');
    }
  });
});

describe('C8: the learn paragraph is in every text an agent reads', () => {
  const member = buildTurnLearningDirective({ slug: 'scout-helper', learning: true, pattern: '' });
  const TEXTS: Record<string, string> = {
    'skill/SKILL.md': read('skill/SKILL.md'),
    'skill/references/knowledge-and-recall.md': read('skill/references/knowledge-and-recall.md'),
    'src/templates/CLAUDE.md': read('src/templates/CLAUDE.md'),
    'superBriefing()': superBriefing(),
    'superBriefing(member)': superBriefing(undefined, memberSlotOf({ slug: 'scout-helper', title: 'Scout helper' })),
    SUPER_BRIEF_TEXT,
    CHAT_SURFACE_BRIEFING,
    SUPER_CHILD_BRIEFING,
    buildTurnLearningDirective: member,
    AGENTS_MD_BODY,
  };

  for (const [name, text] of Object.entries(TEXTS)) {
    it(`${name}: when, scope, his quote, same or replaces by id, never stricter`, () => {
      expect(text, name).toContain('dreamcontext learn "');
      expect(text, name).toMatch(/--scope me/);
      expect(text, name).toContain('--quote "<his exact words>"');
      expect(text, name).toContain('--same <id>');
      expect(text, name).toContain('--replaces <id>');
      expect(text, name).toMatch(phrase('stricter than his words'));
    });
  }

  for (const name of ['skill/SKILL.md', 'src/templates/CLAUDE.md', 'superBriefing()', 'CHAT_SURFACE_BRIEFING', 'AGENTS_MD_BODY', 'skill/references/knowledge-and-recall.md']) {
    it(`${name}: a correction counts without the word "remember", and three scopes`, () => {
      const text = TEXTS[name]!;
      expect(text, name).toMatch(/correct(s|ion of)\s+how\s+agents\s+work/);
      expect(text, name).toMatch(/"remember" said or not|with or without the word "remember"/);
      expect(text, name).toContain('--scope me|project|member');
    });
  }

  for (const name of ['skill/SKILL.md', 'src/templates/CLAUDE.md', 'superBriefing()', 'CHAT_SURFACE_BRIEFING', 'AGENTS_MD_BODY', 'buildTurnLearningDirective', 'skill/references/knowledge-and-recall.md']) {
    it(`${name}: repeats the receipt, never the tool's own memory`, () => {
      const text = TEXTS[name]!;
      expect(text, name).toMatch(/receipt/);
      expect(text, name).toMatch(/(Claude's or Codex's|Codex's or Claude's) own memory/);
    });
  }

  it('no text tells the agent to paste a learned card while the view has no such type', () => {
    // Class guard (owner-surface-without-renderer): a card the view cannot draw shows him "a view
    // type this app doesn't have" instead of the rule line and its undo. Lifts when W2 adds it.
    if ((VIEW_TYPES as readonly string[]).includes('learned')) return;
    const all: Record<string, string> = {
      ...TEXTS,
      'agents/sleep-product.md': read('agents/sleep-product.md'),
      'agents/sleep-state.md': read('agents/sleep-state.md'),
      'skill/references/sleep-specialists.md': read('skill/references/sleep-specialists.md'),
    };
    for (const [name, text] of Object.entries(all)) {
      expect(text, name).not.toContain('"type":"learned"');
      expect(text, name).not.toMatch(/learned`?\s+card/i);
    }
  });

  for (const name of ['skill/SKILL.md', 'src/templates/CLAUDE.md', 'superBriefing()', 'CHAT_SURFACE_BRIEFING', 'AGENTS_MD_BODY', 'buildTurnLearningDirective', 'skill/references/knowledge-and-recall.md']) {
    it(`${name}: the receipt line is repeated verbatim`, () => {
      expect(TEXTS[name]!, name).toMatch(/receipt[\s\S]{0,40}verbatim|verbatim[\s\S]{0,40}receipt/);
    });
  }

  it('the member directive splits a rule about him from a lesson about its own job (D2)', () => {
    expect(member).toContain('dreamcontext automations learn scout-helper --lesson');
    expect(member).toContain('dreamcontext learn "<the rule>" --scope me');
    expect(member.indexOf('automations learn')).toBeLessThan(member.indexOf('dreamcontext learn "'));
    // Still nothing at all when the member does not learn.
    expect(buildTurnLearningDirective({ slug: 'scout-helper', learning: false, pattern: '' })).toBe('');
  });

  it('a Super child leaves a rule that reached it only as an Owner: quote to the Super', () => {
    expect(SUPER_CHILD_BRIEFING).toMatch(phrase('as an `Owner:` quote in your brief is the Super\'s: do not learn it again'));
  });
});

describe('C10: what the Super passes on', () => {
  const briefs: Array<[string, string]> = [
    ['superBriefing()', superBriefing()],
    ['superBriefing(member)', superBriefing(undefined, memberSlotOf({ slug: 'scout-helper', title: 'Scout helper' }))],
    ['SUPER_BRIEF_TEXT', SUPER_BRIEF_TEXT],
  ];
  for (const [name, b] of briefs) {
    it(`${name}: his decision is quoted under Owner:, the Super's reading apart and never softer`, () => {
      expect(b, name).toMatch(phrase("His decision goes into a child's brief as his own words, quoted, under an `Owner:` line."));
      expect(b, name).toMatch(phrase('never narrows, softens or contradicts his'));
      expect(b, name).toMatch(phrase('the brief says both, and that his word decides'));
    });
    it(`${name}: an approved text not sent yet is a file under state/.super/approved/ (main's only)`, () => {
      const approved = phrase('save it as a file under `_dream_context/state/.super/approved/` when he approves it');
      // The folder is main's: a member Super's handoff lists nothing from it, so its brief does not say so.
      if (name === 'superBriefing(member)') { expect(b, name).not.toMatch(approved); return; }
      expect(b, name).toMatch(approved);
      expect(b, name).toMatch(phrase('remove the file once the send is confirmed'));
    });
  }
});

describe('C5: the sleep procedures', () => {
  const product = read('agents/sleep-product.md');
  const state = read('agents/sleep-state.md');

  it('sleep-product learns through learn --by sleep, one call per finding, quotes verbatim', () => {
    expect(product).toContain('dreamcontext learn "<the rule, in his terms>" --by sleep');
    expect(product).toMatch(phrase('Per finding, ONE call, its quotes copied verbatim'));
    expect(product).toMatch(phrase('Never stricter than his words.'));
    expect(product).toMatch(phrase('A rule seen on a single occasion'));
    expect(product).toMatch(phrase('is left for the next sleep'));
  });

  it('sleep-product carries the opposite-instruction step: search, flag with --supersedes, never rewrite', () => {
    expect(product).toMatch(phrase('**The opposite instruction.**'));
    expect(product).toMatch(phrase('search the brain for text that tells an agent the opposite'));
    expect(product).toContain('dreamcontext memory recall "<the rule\'s headline>"');
    expect(product).toContain('`--supersedes <path>`');
    expect(product).toMatch(phrase('**Never rewrite that text**'));
    expect(product).toMatch(phrase('leaves the brain as it was'));
    expect(product).toMatch(phrase('A file that contradicts itself'));
  });

  it('sleep-state writes one Known Issues line per repeated tool error, nothing without a fix', () => {
    expect(state).toMatch(phrase('**Repeated tool errors → Known Issues.**'));
    expect(state).toMatch(phrase('write ONE Known Issues line per error'));
    expect(state).toMatch(phrase('the error, the fix, since when'));
    expect(state).toMatch(phrase('No fix on record in the session: write nothing for that error'));
    expect(state).toMatch(phrase('never `learn` it'));
  });

  it('sleep-state leaves his rules to sleep-product', () => {
    expect(state).toMatch(phrase('is not yours to write'));
    expect(state).toContain('dreamcontext learn --by sleep');
  });
});
