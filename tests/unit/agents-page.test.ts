/**
 * Wave 4b, lane T7: the Agents page (S1, S7, A12's "the page is where approval happens").
 *
 * TWO HALVES. The page's decisions live in pure helpers exported beside the components (the two
 * approval chips, the usage counts, the identity patch, the call settings read from the review,
 * the in-use refusal, the focus intent); those are driven directly. The render CONDITIONS (Approve
 * only inside the in-place review, no browser dialog, no Run now, Talk to it opens Chat) cannot be
 * mounted here (root vitest is plain Node, no DOM), so they are pinned by reading the source, the
 * way `agents-rail-routing.test.ts` does. What renders is `scripts/verify/agents-page.mjs`'s job.
 */
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('../../dashboard/src/context/VaultContext', () => ({
  useApi: () => null,
  useVault: () => ({ vault: null, instanceId: 'test', isActive: true, bus: new EventTarget() }),
  useInstanceEvent: () => undefined,
  emitInstance: () => undefined,
}));

import { RequestError } from '../../dashboard/src/api/client';
import type { AgentSummary } from '../../dashboard/src/hooks/useAgents';
import { renderApprovalReview } from '../../src/lib/automations/registry';
import type { ApprovalPayloadFields } from '../../src/lib/automations/types';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

// The Agents page was retired into the AI Team (2026-10-20): the page checks read the AI Team,
// and the roster card's rules moved to the card's own stylesheet.
const PAGE = 'dashboard/src/pages/AiTeamPage.tsx';
const PAGE_CSS = 'dashboard/src/components/agents/AgentRosterCard.css';
const CARD = 'dashboard/src/components/agents/AgentRosterCard.tsx';
const PANEL = 'dashboard/src/components/agents/AgentProfilePanel.tsx';
const PANEL_CSS = 'dashboard/src/components/agents/AgentProfilePanel.css';
const DIALOG = 'dashboard/src/components/agents/AgentIdentityDialog.tsx';
const DIALOG_CSS = 'dashboard/src/components/agents/AgentIdentityDialog.css';
const TSX = [PAGE, CARD, PANEL, DIALOG];
const CSS = [PAGE_CSS, PANEL_CSS, DIALOG_CSS];

/** Source with comments removed, so prose explaining a rule never satisfies the rule. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

function agent(slug: string, over: Partial<AgentSummary> = {}): AgentSummary {
  return {
    slug,
    title: slug,
    hasPhoto: false,
    description: '',
    soulExcerpt: '',
    roleLine: '',
    model: null,
    effort: null,
    whiteboard: null,
    shared: false,
    approvedForChat: true,
    approvedToRun: true,
    approvalReason: null,
    implicit: false,
    hasCallSettings: false,
    usedBy: { automations: [], boards: [], tasks: [] },
    ...over,
  };
}

function fields(over: Partial<ApprovalPayloadFields> = {}): ApprovalPayloadFields {
  return {
    prompt: 'You research.\nAnswer with sources.',
    outputInstructions: '',
    model: 'opus',
    effort: 'high',
    timeoutMinutes: 15,
    outputDir: null,
    learning: true,
    review: 'off',
    flow: null,
    whiteboard: null,
    job: '',
    soul: '',
    ...over,
  };
}

describe('the roster card (S1)', () => {
  it('shows chat and run approval as two chips, chat first, never one', async () => {
    const { approvalChips } = await import('../../dashboard/src/components/agents/AgentRosterCard');
    const chips = approvalChips(agent('scout', { approvedForChat: true, approvedToRun: false }));
    expect(chips.map((c) => [c.kind, c.ok])).toEqual([['chat', true], ['run', false]]);
    expect(chips[0].labelKey).toBe('agents.approval.chatOk');
    expect(chips[1].labelKey).toBe('agents.approval.runNo');
    const none = approvalChips(agent('x', { approvedForChat: false, approvedToRun: false }));
    expect(none.map((c) => c.labelKey)).toEqual(['agents.approval.chatNo', 'agents.approval.runNo']);
  });

  it('counts usage per kind', async () => {
    const { usageCounts } = await import('../../dashboard/src/components/agents/AgentRosterCard');
    const a = agent('scout', {
      usedBy: {
        automations: [{ slug: 'digest', title: 'Digest', enabled: true, nextFireAt: null }],
        boards: ['plan', 'ops'],
        tasks: [{ slug: 't', name: 'T', status: 'todo' }],
      },
    });
    expect(usageCounts(a)).toEqual({ automations: 1, boards: 2, tasks: 1, total: 4 });
    expect(usageCounts(agent('idle')).total).toBe(0);
  });

  it('falls back to English copy only when a key has none', async () => {
    const { tx } = await import('../../dashboard/src/components/agents/AgentRosterCard');
    expect(tx((k) => k, 'agents.nope', 'Fallback')).toBe('Fallback');
    expect(tx(() => 'Translated', 'agents.yes', 'Fallback')).toBe('Translated');
  });

  it('is a portrait: 96px face, name, role line, soul or the no-soul line, works on, quiet state; no chip', () => {
    const src = code(read(CARD));
    const card = src.slice(src.indexOf('export function AgentRosterCard'), src.indexOf('export function AgentTeamSeat'));
    expect(card).toMatch(/<AgentAvatar of="agent" slug=\{agent\.slug\} title=\{agent\.title\} hasPhoto=\{agent\.hasPhoto\} size=\{96\} \/>/);
    expect(card).toMatch(/className="agr-name">\{agent\.title\}/);
    expect(card).toMatch(/className="agr-role">\{agent\.roleLine\}/);
    expect(card).toMatch(/agent\.soulExcerpt\s*\?\s*<span className="agr-soul">\{agent\.soulExcerpt\}<\/span>\s*:\s*<span className="agr-soul agr-soul--empty">\{t\('agents\.team\.noSoul'\)\}/);
    expect(card).toMatch(/worksOnLine\(agent, t\)/);
    expect(card).toMatch(/t\('agents\.team\.worksNowhere'\)/);
    expect(card).toMatch(/data-approval-state=\{state\}/);
    expect(card).toMatch(/const state = approvalState\(agent\);/);
    expect(card).toMatch(/\{stateHasDot\(state\) && <span className="agr-dot" aria-hidden="true" \/>\}/);
    // Anatomy order, top to bottom.
    const order = ['<AgentAvatar', 'agr-name', 'agr-role', 'agr-soul', 'agr-works', 'agr-foot', 'agr-state'].map((c) => card.indexOf(c));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(card).not.toMatch(/agr-chip/);
    expect(card).not.toMatch(/approvalChips/);
  });

  it('the soul excerpt is a rule, never a fill (U1), and the dot is the warning ink (3:1 on the light card)', () => {
    const css = read(PAGE_CSS);
    const soul = css.slice(css.indexOf('.agr-soul {'), css.indexOf('}', css.indexOf('.agr-soul {')));
    expect(soul).toMatch(/border-left: 2px solid var\(--color-border-hover\);/);
    expect(soul).toMatch(/padding-left: var\(--space-3\);/);
    expect(soul).not.toMatch(/background/);
    const dot = css.slice(css.indexOf('.agr-dot {'), css.indexOf('}', css.indexOf('.agr-dot {')));
    expect(dot).toMatch(/background: var\(--color-warning-ink\);/);
    const name = css.slice(css.indexOf('.agr-name {'), css.indexOf('}', css.indexOf('.agr-name {')));
    expect(name).toMatch(/font-size: var\(--font-size-base\);/);
  });

  it('"Works on" lists each kind that has any, with its count, or nothing', async () => {
    const { worksOnLine } = await import('../../dashboard/src/components/agents/AgentRosterCard');
    const t = (k: string) => ({ 'agents.profile.usage.automations': 'Automations', 'agents.profile.usage.boards': 'Boards', 'agents.profile.usage.tasks': 'Tasks' } as Record<string, string>)[k] ?? k;
    const a = agent('scout', {
      usedBy: {
        automations: [{ slug: 'd', title: 'D', enabled: true, nextFireAt: null }],
        boards: ['plan', 'ops'],
        tasks: [],
      },
    });
    expect(worksOnLine(a, t)).toBe('Automations 1 · Boards 2');
    expect(worksOnLine(agent('idle'), t)).toBe('');
  });
});

describe('the profile: call settings are read from the review, read-only', () => {
  it('parses the review the server renders, multi-line values included', async () => {
    const { parseReviewFields } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    const review = renderApprovalReview(fields({ outputDir: 'reports/scout', review: 'agent' }));
    const map = parseReviewFields(review);
    expect(map.get('prompt')).toBe('You research.\nAnswer with sources.');
    expect(map.get('timeoutMinutes')).toBe('15');
    expect(map.get('outputDir')).toBe('reports/scout');
    expect(map.get('review')).toBe('agent');
    expect(map.get('flow')).toBe('(none)');
  });

  it('names each call setting, and "(none)" reads as not set', async () => {
    const { callSettingRows } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    const rows = callSettingRows(renderApprovalReview(fields({ timeoutMinutes: 30 })));
    expect(rows).toEqual([
      { key: 'timeout', value: '30' },
      { key: 'outputDir', value: null },
      { key: 'review', value: 'off' },
      { key: 'flow', value: null },
    ]);
  });

  it('shows call settings only when the agent has them, and offers no editor for them', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/agent\.hasCallSettings && \(/);
    expect(src).toMatch(/callSettingRows\(detail\.data\.review\)/);
    const dialog = code(read(DIALOG));
    for (const field of ['timeoutMinutes', 'outputDir', 'outputInstructions', 'flow']) {
      expect(dialog).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
  });
});

describe('the profile: approval is separate, and happens in place (S1, A12)', () => {
  it('maps a refusal reason to its key, or the plain "not approved to run"', async () => {
    const { approvalReasonKey } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    expect(approvalReasonKey('manifest-changed')).toBe('agents.approval.reason.manifest-changed');
    expect(approvalReasonKey(null)).toBe('agents.approval.runNo');
  });

  it('renders one row per verdict', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/approvalChips\(agent\)\.map\(\(chip\) => \(\s*<div key=\{chip\.kind\} className="agp-approval-row"/);
  });

  it('no Approve in the profile (plan-r10 1e): the approval rows are read-only and name the one card', () => {
    const src = code(read(PANEL));
    expect(src).not.toMatch(/useApproveAgent|approve\.mutate\(|doApprove|agents\.approval\.approve'/);
    const approval = src.slice(src.indexOf('data-section="approval"'), src.indexOf('</section>', src.indexOf('data-section="approval"')));
    expect(approval).toMatch(/data-approval-waits/);
    // A synced or waiting change names its fields; otherwise the line points at the card.
    expect(approval).toMatch(/t\('agents\.approval\.synced'\)\.replace\('\{fields\}'/);
    expect(approval).toMatch(/t\('agents\.approval\.waitsCard'\)/);
    expect(src).toMatch(/view === 'off' && <p className="agp-empty">\{t\('agents\.profile\.patternOff'\)\}/);
    expect(src).toMatch(/view === 'empty' && <p className="agp-empty">\{t\('agents\.profile\.patternEmpty'\)\}/);
    expect(src).toMatch(/view === 'off-stale' && <p className="agp-empty">\{t\('agents\.profile\.patternOffStale'\)\}/);
    const pattern = src.slice(src.indexOf('data-section="pattern"'), src.indexOf('data-section="usage"'));
    expect(pattern).not.toMatch(/mutate\(|useMutation|onEdit/);
  });

  it('the header carries the quiet state and no Review link: nothing to approve here', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/size=\{72\}/);
    expect(src).toMatch(/className=\{`agp-state agp-state--\$\{state\}`\}/);
    expect(src).not.toMatch(/reviewFromHeader|openReview|data-review-approval/);
    // One filled accent: Talk to it. There is no Approve button any more.
    expect(src.match(/agp-btn--primary/g)).toHaveLength(1);
  });
});

describe('the identity dialog: the soul (T8)', () => {
  it('starts empty, and an edit seeds the FULL soul from the detail, never the excerpt', async () => {
    const { EMPTY_IDENTITY_FORM, formFromAgent } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    expect(EMPTY_IDENTITY_FORM.soul).toBe('');
    const form = formFromAgent(agent('scout', { soulExcerpt: 'Short…' }), 'You scout.', true, 'The whole soul.\n- line two');
    expect(form.soul).toBe('The whole soul.\n- line two');
    const src = code(read(DIALOG));
    expect(src).toMatch(/formFromAgent\(detail\.data\.agent, detail\.data\.prompt, detail\.data\.learning, detail\.data\.soul \?\? ''\)/);
    expect(src).not.toMatch(/soulExcerpt/);
  });

  it('an edit sends the soul only when it changed, and an emptied soul clears it', async () => {
    const { identityPatch, formFromAgent } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    const before = formFromAgent(agent('scout', { title: 'Scout' }), 'You scout.', true, 'Be brief.');
    expect(identityPatch(before, { ...before, soul: '  Be brief.\n' })).toEqual({});
    expect(identityPatch(before, { ...before, soul: 'Be thorough. ' })).toEqual({ soul: 'Be thorough.' });
    expect(identityPatch(before, { ...before, soul: '' })).toEqual({ soul: '' });
  });

  it('a template REPLACES the text and hands back what was there; nothing else moves', async () => {
    const { applySoulTemplate, EMPTY_IDENTITY_FORM } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    const { soulTemplate } = await import('../../dashboard/src/generated/soul-templates');
    const start = { ...EMPTY_IDENTITY_FORM, title: 'Scout', prompt: 'You scout.', soul: 'My own words.' };
    const { form, previous } = applySoulTemplate(start, 'harsh-reviewer');
    expect(form.soul).toBe(soulTemplate('harsh-reviewer')!.text);
    expect(previous).toBe('My own words.');
    expect({ ...form, soul: start.soul }).toEqual(start);
    const second = applySoulTemplate(form, 'calm-helper');
    expect(second.previous).toBe(soulTemplate('harsh-reviewer')!.text);
  });

  it('refuses a "## " line and an over-long soul, with the shared rule', async () => {
    const { identityFormError, EMPTY_IDENTITY_FORM } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    const ok = { ...EMPTY_IDENTITY_FORM, title: 'Scout', prompt: 'You scout.' };
    expect(identityFormError({ ...ok, soul: 'Be brief.\n## Tone\nDry.' })).toBe('agents.identity.soulHeadingLine');
    expect(identityFormError({ ...ok, soul: 'Be brief.\n  ## Tone' })).toBe('agents.identity.soulHeadingLine');
    expect(identityFormError({ ...ok, soul: 'Be brief.\n### Tone\nDry.' })).toBeNull();
    expect(identityFormError({ ...ok, soul: 'x'.repeat(2001) })).toBe('agents.identity.soulTooLong');
    expect(identityFormError({ ...ok, soul: 'x'.repeat(2000) })).toBeNull();
    expect(code(read(DIALOG))).toMatch(/import \{[^}]*\bsoulProblem\b[^}]*\} from '\.\.\/\.\.\/generated\/soul-templates'/);
  });

  it('the template row: one neutral chip per template, Undo inline, nothing about the pick sent', () => {
    const src = code(read(DIALOG));
    expect(src).toMatch(/SOUL_TEMPLATES\.map\(\(tpl\) =>/);
    expect(src).toMatch(/data-soul-template=\{tpl\.id\}/);
    expect(src).toMatch(/tx\(t, `agents\.soul\.template\.\$\{tpl\.id\}`, tpl\.label\)/);
    expect(src).toMatch(/data-soul-input/);
    expect(src).toMatch(/data-soul-undo/);
    expect(src).not.toMatch(/aria-pressed|aid-chip--on|selectedTemplate/);
    // Create sends the soul text and nothing naming a template.
    // (the draft both the project and the global create send)
    const create = src.slice(src.indexOf('const draft = {'), src.indexOf('create.mutate({ ...draft'));
    expect(create).toMatch(/soul: form\.soul\.trim\(\)/);
    expect(create).not.toMatch(/template/i);
    // Placeholder copy (r2).
    expect(read('dashboard/src/context/I18nContext.tsx')).toContain("'agents.identity.soulPlaceholder': 'Write how it works, or start from a template above.'");
  });

  it('field order: name, job, soul, then model, effort, board', () => {
    const src = code(read(DIALOG));
    const idx = ["t('agents.identity.name')", "t('agents.identity.prompt')", "t('agents.identity.soul')", "t('agents.identity.model')"].map((k) => src.indexOf(k));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });
});

describe('copy: every new key exists in English and Turkish (T5)', () => {
  const KEYS = [
    'agents.team.title', 'agents.team.add', 'agents.team.addHint', 'agents.team.noSoul', 'agents.team.worksOn', 'agents.team.worksNowhere',
    'agents.state.ready', 'agents.state.cantRun', 'agents.state.needsApproval',
    'agents.profile.soul', 'agents.profile.soulHint', 'agents.profile.soulEmpty', 'agents.profile.job',
    'agents.profile.pattern', 'agents.profile.patternHint', 'agents.profile.patternEmpty', 'agents.profile.patternOff',
    'agents.profile.patternOffStale', 'agents.profile.playbook', 'agents.profile.lessons', 'agents.profile.lessonsMore',
    'agents.profile.reviewApproval',
    'agents.identity.soul', 'agents.identity.soulHint', 'agents.identity.soulPlaceholder', 'agents.identity.soulHeadingLine',
    'agents.identity.soulStartFrom', 'agents.identity.soulReplaced', 'agents.identity.soulUndo', 'agents.identity.soulTooLong',
    'agents.soul.template.harsh-reviewer', 'agents.soul.template.fast-doer', 'agents.soul.template.careful-researcher',
    'agents.soul.template.plain-writer', 'agents.soul.template.calm-helper',
  ];

  it('each key is written exactly twice (en, then tr), with no em dash', () => {
    const i18n = read('dashboard/src/context/I18nContext.tsx');
    for (const k of KEYS) {
      const hits = [...i18n.matchAll(new RegExp(`'${k.replace(/\./g, '\\.')}': (['"])(.*?)\\1,`, 'g'))].map((m) => m[2]);
      expect(hits, k).toHaveLength(2);
      for (const h of hits) expect(h, k).not.toContain('—');
    }
  });

  it('a template label covers every template id', async () => {
    const { SOUL_TEMPLATE_IDS } = await import('../../dashboard/src/generated/soul-templates');
    for (const id of SOUL_TEMPLATE_IDS) expect(KEYS).toContain(`agents.soul.template.${id}`);
  });

  it('the retired "Who it is" profile key is gone', () => {
    expect(read('dashboard/src/context/I18nContext.tsx')).not.toContain("'agents.profile.prompt':");
  });
});
