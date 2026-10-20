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

  it('Approve exists only inside the review, which re-reads the agent before it opens', () => {
    const src = code(read(PANEL));
    expect(src.match(/approve\.mutate\(/g)).toHaveLength(1);
    const review = src.slice(src.indexOf('{reviewing && ('), src.indexOf('</section>', src.indexOf('{reviewing && (')));
    expect(review).toMatch(/detail\.data\?\.review/);
    expect(review).toMatch(/onClick=\{doApprove\}/);
    expect(src.match(/onClick=\{doApprove\}/g)).toHaveLength(1);
    expect(src).toMatch(/const openReview = \(\) => \{[\s\S]*?setReviewing\(true\);[\s\S]*?detail\.refetch\(\)/);
    expect(review).toMatch(/disabled=\{approve\.isPending \|\| detail\.isFetching \|\| !detail\.data\}/);
  });
});

describe('the profile: Talk to it and delete (S1)', () => {
  it('Talk to it asks Chat for a new conversation, then opens Chat; says so when nothing took it', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/requestTalkToAgent\(slug\)\.then\(\(accepted\) => \{[\s\S]*?if \(accepted\) openAgentSurface\(bus\);\s*else setTalkError\(t\('agents\.profile\.talkFailed'\)\)/);
    expect(src).toMatch(/disabled=\{!agent\.approvedForChat \|\| talking\}/);
  });

  it('recognises the 409 agent_in_use refusal and names what uses the agent', async () => {
    const { inUseNames, isAgentInUse } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    expect(isAgentInUse(new RequestError('in use', 409, 'agent_in_use'))).toBe(true);
    expect(isAgentInUse(new RequestError('nope', 404, 'not_found'))).toBe(false);
    expect(isAgentInUse(new Error('agent_in_use'))).toBe(false);
    const a = agent('scout', {
      usedBy: {
        automations: [
          { slug: 'digest', title: 'Morning digest', enabled: true, nextFireAt: null },
          { slug: 'weekly', title: 'Weekly report', enabled: false, nextFireAt: null },
        ],
        boards: [],
        tasks: [],
      },
    });
    expect(inUseNames(a)).toEqual(['Morning digest', 'Weekly report']);
    expect(inUseNames(a, ['weekly', 'gone'])).toEqual(['Weekly report', 'gone']);
  });

  it('delete is a two-click in-place confirm that surfaces the in-use list', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/deleteAction\(armed\) === 'arm'/);
    expect(src).toMatch(/isAgentInUse\(err\)[\s\S]*?t\('agents\.profile\.deleteInUse'\)[\s\S]*?inUseNames\(agent\)/);
    expect(src).toMatch(/t\('agents\.profile\.deleteConfirm'\)/);
  });
});

describe('the identity dialog: create and edit', () => {
  it('requires a name and a prompt', async () => {
    const { identityFormError, EMPTY_IDENTITY_FORM } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    expect(identityFormError(EMPTY_IDENTITY_FORM)).toBe('agents.identity.nameRequired');
    expect(identityFormError({ ...EMPTY_IDENTITY_FORM, title: 'Scout' })).toBe('agents.identity.promptRequired');
    expect(identityFormError({ ...EMPTY_IDENTITY_FORM, title: 'Scout', prompt: 'You scout.' })).toBeNull();
  });

  it('an edit sends only what changed, and "default" clears to null', async () => {
    const { identityPatch, formFromAgent } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    const before = formFromAgent(agent('scout', { title: 'Scout', model: 'opus', effort: 'high', whiteboard: 'plan' }), 'You scout.', true);
    expect(identityPatch(before, before)).toEqual({});
    expect(identityPatch(before, { ...before, title: '  Scout ' })).toEqual({});
    expect(identityPatch(before, { ...before, model: '', effort: '', whiteboard: '' }))
      .toEqual({ model: null, effort: null, whiteboard: null });
    expect(identityPatch(before, { ...before, prompt: 'You scout harder.', learning: false }))
      .toEqual({ prompt: 'You scout harder.', learning: false });
  });

  it('a truncation refusal gets its own sentence', async () => {
    const { identityErrorKey } = await import('../../dashboard/src/components/agents/AgentIdentityDialog');
    expect(identityErrorKey(new RequestError('cut', 409, 'prompt_truncated'))).toBe('agents.identity.truncated');
    expect(identityErrorKey(new Error('boom'))).toBe('agents.identity.failed');
  });

  it('an edit reads the agent fresh and allows no save until it has', () => {
    const src = code(read(DIALOG));
    expect(src).toMatch(/useAgent\(slug, \{ fresh: true \}\)/);
    expect(src).toMatch(/const ready = original !== null;/);
    expect(src).toMatch(/disabled=\{!ready \|\| busy \|\| !!blocker\}/);
    expect(src).toMatch(/useCreateAgentIdentity\(\)/);
    expect(src).toMatch(/useUpdateAgentIdentity\(\)/);
    expect(src).toMatch(/useUploadAgentIdentityPhoto\(\)/);
  });
});

describe('headings and states (S7)', () => {
  it('the 20px headings keep their word gap: no 40px heading tracking on them', () => {
    for (const [f, cls] of [[PANEL_CSS, '.agp-name {'], [DIALOG_CSS, '.aid-title {']] as const) {
      const css = read(f);
      const block = css.slice(css.indexOf(cls), css.indexOf('}', css.indexOf(cls)));
      expect(block, f).toMatch(/font-size: var\(--font-size-lg\);/);
      expect(block, f).toMatch(/letter-spacing: var\(--letter-spacing-body\);/);
    }
  });
});

describe('the UI rules', () => {
  it('no browser dialog anywhere on the page (silent no-ops in the desktop app)', () => {
    for (const f of TSX) {
      expect(code(read(f)), f).not.toMatch(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/);
    }
  });

  it('no Run now and no Telegram on this page', () => {
    for (const f of TSX) {
      const src = code(read(f));
      expect(src, f).not.toMatch(/run ?now|runNow|useRunAutomation/i);
      expect(src, f).not.toMatch(/telegram/i);
    }
  });

  it('design tokens only: no hardcoded colours or fonts in the CSS', () => {
    for (const f of CSS) {
      const css = read(f).replace(/\/\*[\s\S]*?\*\//g, ' ');
      expect(css, f).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(css, f).not.toMatch(/\b(?:rgb|rgba|hsl|hsla|oklch)\(/);
      // The lookahead carries its own `\s*`: a bare `\s*` before it backtracks to zero and lets
      // ` var(` through as "not var(", failing every tokenised font-family.
      expect(css, f).not.toMatch(/font-family:(?!\s*var\()/);
      expect(css, f).not.toMatch(/font-size:\s*\d/);
    }
  });

  it('no em dash in any copy fallback', () => {
    for (const f of TSX) {
      for (const m of read(f).matchAll(/tx\(t, '[^']+', '([^']*)'\)/g)) {
        expect(m[1], f).not.toContain('—');
      }
    }
  });
});

describe('the team: three approval states, never folded into one (D8, U2)', () => {
  it('maps the four verdict combinations to three states', async () => {
    const { approvalState } = await import('../../dashboard/src/hooks/useAgents');
    expect(approvalState({ approvedForChat: true, approvedToRun: true })).toBe('ready');
    expect(approvalState({ approvedForChat: true, approvedToRun: false })).toBe('cant-run');
    expect(approvalState({ approvedForChat: false, approvedToRun: false })).toBe('needs-approval');
    // No chat outranks a run grant: it can't speak, so it needs approval.
    expect(approvalState({ approvedForChat: false, approvedToRun: true })).toBe('needs-approval');
  });

  it('only the attention states carry a dot; "Ready" is a plain word', async () => {
    const { stateHasDot, APPROVAL_STATE_KEY } = await import('../../dashboard/src/components/agents/AgentRosterCard');
    expect(stateHasDot('ready')).toBe(false);
    expect(stateHasDot('cant-run')).toBe(true);
    expect(stateHasDot('needs-approval')).toBe(true);
    expect(APPROVAL_STATE_KEY).toEqual({
      ready: 'agents.state.ready',
      'cant-run': 'agents.state.cantRun',
      'needs-approval': 'agents.state.needsApproval',
    });
  });

  it('"Can\'t run yet" reads as blocked, not as a chosen mode, in both languages', () => {
    const i18n = read('dashboard/src/context/I18nContext.tsx');
    const words = [...i18n.matchAll(/'agents\.state\.cantRun': (['"])(.*?)\1,/g)].map((m) => m[2]);
    expect(words).toEqual(["Can't run yet", 'Henüz çalışamaz']);
    for (const w of words) expect(w.toLowerCase()).not.toMatch(/only|yalnızca|sadece/);
  });

  it('the roster spends no filled accent', () => {
    expect(read(PAGE_CSS)).not.toMatch(/gradient-brand/);
  });
});

describe('the profile: soul, job, pattern, where it works, approval (T7)', () => {
  it('sections come in the order soul, job, pattern, usage, approval', () => {
    const src = code(read(PANEL));
    const sections = [...src.matchAll(/data-section="([a-z]+)"/g)].map((m) => m[1]);
    expect(sections).toEqual(['soul', 'job', 'pattern', 'usage', 'approval']);
  });

  it('shows the full soul from the detail, or the empty line', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/const soul = data\?\.soul \?\? '';/);
    expect(src).toMatch(/<div className="agp-soul"><TextBlocks text=\{soul\} \/><\/div>/);
    expect(src).toMatch(/<div className="agp-playbook"><TextBlocks text=\{data\.pattern\.playbook\} \/><\/div>/);
    expect(src).toMatch(/t\('agents\.profile\.soulEmpty'\)/);
  });

  it('splits a soul into paragraphs and bulleted lists by line, no markdown library', async () => {
    const { textBlocks } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    expect(textBlocks('You are calm.\n- One step.\n* Two steps.\n• Three.\n\nThen stop.\nPlainly.')).toEqual([
      { kind: 'p', text: 'You are calm.' },
      { kind: 'ul', items: ['One step.', 'Two steps.', 'Three.'] },
      { kind: 'p', text: 'Then stop.' },
      { kind: 'p', text: 'Plainly.' },
    ]);
    expect(textBlocks('- a\nmid\n- b')).toEqual([
      { kind: 'ul', items: ['a'] }, { kind: 'p', text: 'mid' }, { kind: 'ul', items: ['b'] },
    ]);
    expect(textBlocks('-5 degrees.\n**Bold**')).toEqual([{ kind: 'p', text: '-5 degrees.' }, { kind: 'p', text: '**Bold**' }]);
    expect(textBlocks('  \n')).toEqual([]);
    expect(code(read(PANEL))).toMatch(/<ul key=\{i\} className="agp-bullets">/);
  });

  it('shows the first five lessons, then all', async () => {
    const { visibleLessons, LESSONS_SHOWN } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    const seven = [1, 2, 3, 4, 5, 6, 7];
    expect(LESSONS_SHOWN).toBe(5);
    expect(visibleLessons(seven, false)).toEqual([1, 2, 3, 4, 5]);
    expect(visibleLessons(seven, true)).toEqual(seven);
    expect(visibleLessons([1, 2], false)).toEqual([1, 2]);
    expect(visibleLessons(seven, false, 2)).toEqual([1, 2]);
  });

  it('reads the pattern as off, off with notes kept, empty, or present (D7)', async () => {
    const { patternView } = await import('../../dashboard/src/components/agents/AgentProfilePanel');
    const none = { playbook: '', lessons: [] };
    const lesson = { playbook: '', lessons: [{ date: '2026-10-01', text: 'Cite the source.' }] };
    const playbook = { playbook: 'Lead with the answer.', lessons: [] };
    expect(patternView(false, none)).toBe('off');
    expect(patternView(false, lesson)).toBe('off-stale');
    expect(patternView(true, none)).toBe('empty');
    expect(patternView(true, { playbook: '  \n', lessons: [] })).toBe('empty');
    expect(patternView(true, lesson)).toBe('present');
    expect(patternView(true, playbook)).toBe('present');
    expect(patternView(true, undefined)).toBe('empty');
  });

  it('each pattern state has its own sentence, and the pattern is read-only', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/view === 'off' && <p className="agp-empty">\{t\('agents\.profile\.patternOff'\)\}/);
    expect(src).toMatch(/view === 'empty' && <p className="agp-empty">\{t\('agents\.profile\.patternEmpty'\)\}/);
    expect(src).toMatch(/view === 'off-stale' && <p className="agp-empty">\{t\('agents\.profile\.patternOffStale'\)\}/);
    const pattern = src.slice(src.indexOf('data-section="pattern"'), src.indexOf('data-section="usage"'));
    expect(pattern).not.toMatch(/mutate\(|useMutation|onEdit/);
  });

  it('the header carries the quiet state and a Review link when not ready', () => {
    const src = code(read(PANEL));
    expect(src).toMatch(/size=\{72\}/);
    expect(src).toMatch(/className=\{`agp-state agp-state--\$\{state\}`\}/);
    expect(src).toMatch(/\{state !== 'ready' && \(\s*<button type="button" className="agp-textbtn" onClick=\{reviewFromHeader\}/);
    expect(src).toMatch(/const reviewFromHeader = \(\) => \{\s*openReview\(\);/);
    // One filled accent while no review is open: Talk to it. Approve is the other, inside the review.
    expect(src.match(/agp-btn--primary/g)).toHaveLength(2);
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
    const create = src.slice(src.indexOf('create.mutate({'), src.indexOf('}, { onSuccess: finish, onError: fail });', src.indexOf('create.mutate({')));
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
