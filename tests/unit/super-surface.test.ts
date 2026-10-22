/**
 * The hand-over screen as wired into the Chat surface (plan-r7 lane U; AC1 window half, AC4,
 * AC6 client half, AC12 window rules, AC14). Vitest runs plain Node with no DOM, so the
 * behaviour lives in pure modules (tested in super-handover-model / super-layout /
 * handover-motion / super-web-budget) and what only the component tree can show is pinned
 * here by reading the source — the way mascot-mode-gear and agent-status-project-rollup do.
 * What only a browser can prove (the flights, the 1 px landing, the screenshots) is the lead's
 * scripts/verify/super-agent.mjs.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_POST_GAP_MS, createActivityLease } from '../../dashboard/src/components/sleepy/super/superApi.js';
import { deriveSessionStatus, rollupProject, type SessionRow } from '../../dashboard/src/components/sleepy/agentStatus.js';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf-8');
const DASH = 'dashboard/src';
const SLEEPY = `${DASH}/components/sleepy`;
const surface = read(`${SLEEPY}/AgentSurface.tsx`);
const superDir = `${SLEEPY}/super`;

describe('the Super Agent is never a tab (D9, AC1)', () => {
  it('the roster save never writes it: a relaunch after take-back shows no super tab', () => {
    const save = surface.slice(surface.indexOf('sessions: [...sessionList'), surface.indexOf('withBaseGeneration(payload'));
    expect(save).toMatch(/\.filter\(\(m\) => !isSuperSession\(m, superStateRef\.current\?\.session\)\)/);
  });

  it('the restore checks the predicate INSIDE the index-aligned grouping loop (never into pane 0)', () => {
    const loop = surface.slice(surface.indexOf('restored.forEach((m, i) => {'), surface.indexOf('const ordered = [...groups.entries()]'));
    expect(loop).toMatch(/if \(isSuperSession\(\{ mode: m\.mode \?\? saved\.mode, claudeId: saved\.sessionId \}/);
    // …and BEFORE the pane index is read off the saved entry.
    // (Code lines, not comment text: the pane read is the `Math.floor(saved.pane ?? 0)` statement.)
    expect(loop.indexOf('if (isSuperSession(')).toBeLessThan(loop.indexOf('Math.floor(saved.pane ?? 0)'));
    expect(loop.indexOf('Math.floor(saved.pane ?? 0)')).toBeGreaterThan(-1);
  });

  it('the orphan reconcile never adopts it; the dock and the corner chips never show it', () => {
    const reconcile = surface.slice(surface.indexOf('// Defensive reconcile'), surface.indexOf('// ── Orphan detector'));
    expect(reconcile).toMatch(/!isSuperSession\(m, superStateRef\.current\?\.session\)/);
    expect(surface).toMatch(/const dockRows: SessionRow\[\] = sessionList\.filter\(\(meta\) => !isSuperSession\(meta, superState\?\.session\)\)/);
    // The corner chips are built from the dock rows.
    expect(surface).toMatch(/\.map\(\(id\) => dockRows\.find\(\(r\) => r\.id === id\)\)/);
  });

  it('it joins the roster with mode super and is placed in NO pane', () => {
    const ensure = surface.slice(surface.indexOf('const ensureSuperSession'), surface.indexOf('// ── What the server pushes'));
    expect(ensure).toMatch(/spawn\(false, session, !fresh, 'chat', '', superModel, true, '', false, superEffort, false, 'super'\)/);
    expect(ensure).toMatch(/mode: 'super'/);
    expect(ensure).not.toMatch(/setPanes/);
  });

  it('it follows the vault\'s permission switch like any chat (decision 14): no explicit bypass on its spawn or its children\'s', () => {
    // Param 11 (explicitBypass) is false, so `spawn`'s chat arm takes the vault's remembered mode.
    expect(surface).toMatch(/spawn\(false, session, !fresh, 'chat', '', superModel, true, '', false, superEffort, false, 'super'\)/);
    // The child's id is minted first so its lean MCP set (orchestration plan r5 D14) is known at the spawn.
    expect(surface).toMatch(/spawn\(false, childId, false, 'chat', prepared\.inline, d\.model, true, prepared\.token, false, d\.effort, false, d\.mode\)/);
  });

  it('past chats never reopen its conversation as a tab', () => {
    const resume = surface.slice(surface.indexOf('const resumePastSession = useCallback'), surface.indexOf('const existing = sessionList.find((m) => m.claudeId === past.id);'));
    expect(resume).toMatch(/if \(past\.id === superStateRef\.current\?\.session\) return;/);
  });
});

describe('hand over / take back (D5, D9, D17)', () => {
  it('the hand-over posts the adoption body built with the predicate (never the super itself)', () => {
    const hand = surface.slice(surface.indexOf('const handOver = useCallback'), surface.indexOf('const takeBack = useCallback'));
    expect(hand).toMatch(/const body = adoptionBody\(tabs, before\?\.session\);/);
    expect(hand).toMatch(/await enableSuper\(scopedApi, body\)/);
    // First rects in ONE batch BEFORE the request and the DOM switch (D18).
    expect(hand.indexOf('const first = new Map')).toBeLessThan(hand.indexOf('await enableSuper'));
    expect(hand.indexOf('await enableSuper')).toBeLessThan(hand.indexOf("setSuperView('super')"));
  });

  it('take-back never touches the panes: they stay mounted (hidden) and return exactly as they were', () => {
    const take = surface.slice(surface.indexOf('const takeBack = useCallback'), surface.indexOf('const settleReversed'));
    expect(take).not.toMatch(/setPanes/);
    expect(take).toMatch(/await disableSuper\(scopedApi\)/);
    expect(surface).toMatch(/hidden=\{handedOver\}/);
  });

  it('a delegated child lands as a NON-active tab of the active pane (D5)', () => {
    expect(surface).toMatch(/setPanes\(\(prev\) => placeDelegatedChild\(prev, activePaneId, s\.id, nextPaneId\)\.panes\)/);
    expect(surface).toMatch(/return \{ ok: true, result: \{ sessionId: s\.claudeId \} \}/);
  });

  it('an expired `delegate` opens no child: the deadline is checked before any spawn, and again after the prompt wait', () => {
    const del = surface.slice(surface.indexOf("if (verb === 'delegate') {"), surface.indexOf("if (verb === 'answer')"));
    const checks = [...del.matchAll(/if \(delegateExpired\(args\)\) return \{ ok: false, error: 'expired' \};/g)].map((m) => m.index ?? -1);
    expect(checks).toHaveLength(2);
    const spawnAt = del.indexOf('spawn(');
    const prepAt = del.indexOf('await preparePrompt(');
    expect(spawnAt).toBeGreaterThan(-1);
    expect(checks[0]).toBeLessThan(prepAt);
    expect(checks[1]).toBeGreaterThan(prepAt);
    expect(checks[1]).toBeLessThan(spawnAt);
  });

  it('`super answer` re-checks the child\'s pending AskUserQuestion and answers it like its card', () => {
    const answer = surface.slice(surface.indexOf("if (verb === 'answer')"), surface.indexOf("return { ok: false, error: 'unknown_verb' }"));
    expect(answer).toMatch(/if \(!hasOwnKey\(st\.children, child\)\) return \{ ok: false, error: 'not_a_child' \}/);
    expect(answer).toMatch(/p\.kind === 'question' && p\.requestId === requestId/);
    expect(answer).toMatch(/cs\.answerQuestion\(requestId, q\.questions, picks\.picked, picks\.notes\)/);
    expect(answer).not.toMatch(/\.answer\(requestId/);
  });

  it('homing is suspended while handed over: only the centre and the shown child are placed', () => {
    const place = surface.slice(surface.indexOf('const superShownSid = (() =>'), surface.indexOf('// Keep activePaneId pointing at a real pane'));
    // The shown child: the half card, else the first presented chat (plan-r8 F11).
    expect(place).toMatch(/const cid = shownChild\(superState\);/);
    expect(place).toMatch(/homedSessions\(\{ handedOver, superSid, shownSid: superShownSid/);
    expect(place).toMatch(/place\(superSid, 'centre'\)/);
    expect(place).toMatch(/place\(superShownSid, 'shown'\)/);
    expect(place).toMatch(/\[panes, expanded, handedOver, superSid, superShownSid, superSlotEpoch\]/);
  });

  it('no chord opens, splits or closes a hidden pane while handed over; a dropped file goes to the Super Agent', () => {
    expect(surface).toMatch(/if \(superViewRef\.current === 'super'\) return;\n\s*\/\/ ⌃` → new TERMINAL tab/);
    expect(surface).toMatch(/const targetSid = superViewRef\.current === 'super' \? \(superSidRef\.current \?\? ''\)/);
  });

  it('the Super Agent\'s `send` (its `super send`) is re-checked with sid, pin id and the live conversation', () => {
    const guard = surface.slice(surface.indexOf('superWindowGuardRef.current = (cs, verb, args) =>'), surface.indexOf('// The Super Agent\'s session in this window'));
    expect(guard).toMatch(/m\.id === args\.tab \|\| m\.claudeId === args\.tab/);
    expect(guard).toMatch(/target = \{ sid: meta\.id, pin: meta\.claudeId, conversation: live && live\.kind === 'chat' \? live\.claudeId : null \}/);
    expect(guard).toMatch(/children: markedChildren\(superState\)/);
    expect(surface).toMatch(/const refusal = superWindowGuardRef\.current\(cs, verb, args\);\s*if \(refusal\) return \{ ok: false, error: refusal \};/);
  });

  it('the Assistant cannot reach the Super Agent or its children while handed over (window re-check)', () => {
    expect(surface).toMatch(/findChat: \(claudeId\) => \{[\s\S]{0,300}if \(claudeIdIsSuperGuarded\(claudeId\)\) return null;/);
    expect(surface).toMatch(/closeChat: \(claudeId\) => \{\s*if \(claudeIdIsSuperGuarded\(claudeId\)\) return false;/);
  });
});

describe('take-back restores the panes exactly (AC1)', () => {
  // The pane layout is written ONLY by the owner's own pane actions and, while handed over, by
  // the delegate executor's placeDelegatedChild (a NON-active tab of the active pane). The
  // hand-over, the take-back, a reversed flight and a Terminals-row click never write it, so the
  // panes return as they were — a terminal tab included, in its pane and position.
  it('hand-over, take-back, a reversed flight and the Terminals row never write the panes', () => {
    const between = (from: string, to: string) => surface.slice(surface.indexOf(from), surface.indexOf(to));
    expect(between('const handOver = useCallback', 'const takeBack = useCallback')).not.toMatch(/setPanes|setMinimizedIds/);
    expect(between('const takeBack = useCallback', 'const settleReversed')).not.toMatch(/setPanes|setMinimizedIds/);
    expect(between('const settleReversed = useCallback', '// The flight itself')).not.toMatch(/setPanes|setMinimizedIds/);
    expect(between('const openTerminalFromSuper', '// Read each visible pane')).not.toMatch(/setPanes|setMinimizedIds/);
    // The Terminals row lists the terminal tabs; it never takes them out of their panes.
    expect(read(`${superDir}/TerminalsRow.tsx`)).not.toMatch(/setPanes/);
  });

  it('the only pane write while handed over is the delegated child\'s placement', () => {
    const del = surface.slice(surface.indexOf("if (verb === 'delegate') {"), surface.indexOf("if (verb === 'answer')"));
    expect((del.match(/setPanes\(/g) ?? []).length).toBe(1);
    expect(del).toMatch(/setPanes\(\(prev\) => placeDelegatedChild\(prev, activePaneId, s\.id, nextPaneId\)\.panes\)/);
  });

  it('a plain terminal is session-local: it is never saved, so it cannot outlive a reload in ANY mode', () => {
    // `window new --terminal` opens a shell; the roster never saves a shell and the restore drops
    // "Terminal N" rows (the server ends the shell with its socket). A take-back AFTER a reload
    // can therefore not bring it back — not a hand-over rule, the product's terminal rule.
    expect(surface).toMatch(/const s = o\.terminal\s*\? spawn\(false, undefined, false, 'shell'\)/);
    const save = surface.slice(surface.indexOf('sessions: [...sessionList'), surface.indexOf('withBaseGeneration(payload'));
    expect(save).toMatch(/\.filter\(\(m\) => m\.kind !== 'shell'\)/);
  });
});

describe('late hand-over results never overwrite a newer action (AC6)', () => {
  it('take-back takes a generation before its disable and drops a result that is no longer current', () => {
    const take = surface.slice(surface.indexOf('const takeBack = useCallback'), surface.indexOf('const settleReversed'));
    const begin = take.indexOf('const gen = superGenRef.current.begin();');
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(take.indexOf('await disableSuper(scopedApi)'));
    // Both the answer and the failure path check before writing the state.
    const guards = [...take.matchAll(/if \(!superGenRef\.current\.isCurrent\(gen\)\) return;\s*setSuperState/g)];
    expect(guards).toHaveLength(2);
  });

  it('a reversed flight is a new action: its enable / disable results are guarded the same way', () => {
    const settle = surface.slice(surface.indexOf('const settleReversed = useCallback'), surface.indexOf('// The flight itself'));
    expect(settle).toMatch(/const gen = superGenRef\.current\.begin\(\);/);
    expect(settle).toMatch(/\(st\) => \{ if \(current\(\)\) setSuperState/);
    expect(settle).toMatch(/\(\) => \{ if \(current\(\)\) setSuperState/);
    expect(settle).toMatch(/if \(state && current\(\)\) setSuperState\(state\)/);
    // Every setSuperState in it is behind the check.
    expect((settle.match(/setSuperState\(/g) ?? []).length).toBe((settle.match(/current\(\)\) setSuperState\(/g) ?? []).length);
  });

  it('a hand-over also begins a generation, so a take-back\'s late disable cannot land on it', () => {
    const hand = surface.slice(surface.indexOf('const handOver = useCallback'), surface.indexOf('const takeBack = useCallback'));
    expect(hand.indexOf('const gen = superGenRef.current.begin();')).toBeLessThan(hand.indexOf('await enableSuper'));
    expect(hand).toMatch(/if \(st && superGenRef\.current\.isCurrent\(gen\)\) setSuperState\(withPendingEdits\(st\)\)/);
  });
});

describe('quiet children (D16, AC6 client half)', () => {
  it('a child just opened for a delegate stays marked until the record names it (no unmark before the push)', () => {
    const del = surface.slice(surface.indexOf("if (verb === 'delegate') {"), surface.indexOf("if (verb === 'answer')"));
    expect(del).toMatch(/s\.setSuperChild\(true\);/);
    expect(del).toMatch(/setSuperDelegated\(\(prev\) => new Map\(prev\)\.set\(s\.claudeId, markUntil\)\)/);
    expect(del).toMatch(/const markUntil = delegateMarkUntil\(args\);/);
    // The mark effect reads the record AND the pending delegates, never the record alone.
    const effect = surface.slice(surface.indexOf('// ── Mark the children (D16)'), surface.indexOf('// ── The owner-activity lease'));
    expect(effect).toMatch(/const marks = childMarks\(superState, superDelegated, now\);/);
    expect(effect).not.toMatch(/markedChildren\(superState\)/);
    expect(effect).toMatch(/\[superState, sessionList, superDelegated\]/);
    // The dock rows (the project chip) use the same marks.
    expect(surface).toMatch(/const marked = childMarks\(superState, superDelegated, Date\.now\(\)\)\.marked;/);
  });

  it('a marked child\'s question raises no chime, banner, bounce or badge', () => {
    const chat = read(`${SLEEPY}/chatSession.ts`);
    const push = chat.slice(chat.indexOf('function pushAsk('), chat.indexOf('function applyZoom('));
    expect(push).toMatch(/if \(!hadAskBefore\) \{[\s\S]*childAlarm\.ask\(/);
    expect(push).not.toMatch(/raiseAskAttention\(/);
    // The gate: a child raises nothing, an unknown one waits (super-child-alarm.test.ts).
    expect(chat).toMatch(/setSuperChild: \(on: boolean \| null\) => \{\s*childAlarm\.set\(on\);/);
  });

  it('children are marked from the record, and on spawn (no window between spawn and the first frame)', () => {
    expect(surface).toMatch(/cs\.setSuperChild\(superKnownRef\.current \|\| superStateRef\.current\s*\? markedChildren\(superStateRef\.current\)\.has\(cs\.claudeId\)\s*: null\)/);
    // The first GET (or no record to read) makes it known and releases what waited.
    expect(surface).toMatch(/superKnownRef\.current = true;[\s\S]{0,200}setSuperChild\(marked\.has\(s\.claudeId\)\)/);
    // Until the record is read the effect keeps the alarm waiting, never an early "not a child".
    expect(surface).toMatch(/const known = superKnownRef\.current \|\| !!superState;[\s\S]{0,200}\(s as ChatSession\)\.setSuperChild\(known \? set\.has\(s\.claudeId\) : null\)/);
  });

  it('ONE alarm per owner item, EVERY item (not only the head), linked to the super agent, raised where the record lives', () => {
    // Owner 2026-10-22: a super question rings like any agent's question. A normal agent's
    // question rings whatever else is open; the job bar rang only for its head, and only while
    // the stage was mounted. The alarm lives in AgentSurface and walks every owner item.
    const strip = read(`${superDir}/JobBar.tsx`);
    expect(strip).not.toMatch(/raiseAskAttention|headAlarmOnce/);
    const effect = surface.slice(surface.indexOf('const superOwnerItems = useMemo('), surface.indexOf('const superTitleFor = useCallback('));
    expect(effect).toMatch(/superState\.queue\.filter\(needsOwner\)/);
    expect(effect).toMatch(/const fresh = superOwnerItems\.filter\(\(q\) => headAlarmOnce\(vault, q\)\);\s*if \(!fresh\.length\) return;[\s\S]{0,200}raiseAskAttention\(/);
    expect(effect).toMatch(/sessionId: superChatSession\?\.claudeId \?\? null,/);
    expect((surface.match(/raiseAskAttention\(/g) ?? []).length).toBe(1);
    // A banner the server posted (owner-question.ts names it in the view) is never posted twice.
    expect(effect).toMatch(/banner: !\(superBannered \?\? \[\]\)\.includes\(item\.id\),/);
    // The super chat's tab gets the attention badge, like any asking chat.
    expect(effect).toMatch(/superChatSession\.attention = true;\s*bumpStatus\(\);/);
  });

  it('a link to the super agent opens its stage before any resume (AC4)', () => {
    const open = surface.slice(surface.indexOf('useInstanceEvent<OpenSessionDetail>(OPEN_SESSION_EVENT'), surface.indexOf('setLinkedSession({ claudeId: detail.claudeId'));
    // A link that lands before the record waits for it, then re-checks before any resume.
    expect(surface).toMatch(/const ready = caps !== null && settingsReady && hydratedRef\.current && superKnownRef\.current;/);
    expect(surface).toMatch(/setLinkedSession\(null\);\s*if \(!isMobile && !isMacPhoneSurface\(\) && linkOpensSuperStage\(claudeId, superStateRef\.current\)\) \{/);
    expect(open).toMatch(/if \(!isMobile && !isMacPhoneSurface\(\) && linkOpensSuperStage\(detail\.claudeId, superStateRef\.current\)\) \{\s*setSuperView\('super'\);\s*setExpanded\(true\);\s*detail\.accepted = true;\s*return;/);
  });

  it('the project chip ignores marked children and counts only the queue head', () => {
    const asking = (id: string, superChild = false): SessionRow => ({
      id, title: id, kind: 'chat', info: deriveSessionStatus({ status: 'open', asking: true }), attention: true, superChild,
    });
    const quiet = rollupProject([asking('a', true), asking('b', true)]);
    expect(quiet).toMatchObject({ waiting: 0, asking: 0, working: 2, flagged: 0, live: 2 });
    expect(quiet.worst).toBe('working');
    const head = rollupProject([asking('a', true)], { superQueueHead: true });
    expect(head).toMatchObject({ waiting: 1, worst: 'asking' });
    // An unmarked chat still rings as before.
    expect(rollupProject([asking('c')])).toMatchObject({ waiting: 1, asking: 1 });
    expect(surface).toMatch(/rollupProject\(dockRows, \{ superQueueHead: !!superState\?\.enabled && !!queueHead\(superState\) \}\)/);
  });
});

describe('the strip answers once; the button\'s dot is in its name; ids never read the prototype', () => {
  const strip = read(`${superDir}/JobBar.tsx`);

  it('Allow and Deny go through one latch and are disabled once answered', () => {
    // The latch is the one the super chat's question card shares (superQuestions.ts): noted
    // first from the ONE pending input, then read, per item + request key.
    expect(strip).toMatch(/if \(head && answerKey\) noteOwnerPending\(answerKey, ownerPendingPresent\(head, child, openOwnerQuestions\(state\.queue\)\)\);\s*const locked = answerKey !== null && ownerAnswerLocked\(answerKey\);/);
    // The answer rides the child's socket, or for the super agent's own ask its own (verify finding).
    expect(strip).toMatch(/const carrier = head\.kind === 'ask' \? superSession : child;\n\s*if \(!claimOwnerAnswer\(answerKey, head\.id, state\.session \?\? '', carrier\?\.status === 'open'\)\) return;\n\s*if \(send\(\) === false\) releaseOwnerAnswer\(answerKey\);/);
    expect(strip).toMatch(/onClick=\{\(\) => answerOnce\(\(\) => child\.answer\(pending\.requestId, \{ behavior: 'allow'/);
    expect(strip).toMatch(/onClick=\{\(\) => answerOnce\(\(\) => child\.answer\(pending\.requestId, \{ behavior: 'deny'/);
    // No answer path bypasses the latch: the permission's two. A question is answered in the
    // chat's own card (SuperQuestionCard.tsx), never from the bar.
    expect((strip.match(/child\.answer(Question)?\(/g) ?? []).length).toBe(2);
    expect((strip.match(/disabled=\{locked\}/g) ?? []).length).toBe(2);
    expect(strip).not.toMatch(/sendOwnerAnswer|ownerOptionsOf/);
    // The card answers through the AskUserQuestion card's own host: the child's session, or one
    // message to the super (sendToSuper), and a failed send remounts the card.
    const card = read(`${superDir}/SuperQuestionCard.tsx`);
    expect(card).toMatch(/if \(!sendToSuper\(superSession, text\)\) setAttempt\(\(a\) => a \+ 1\);/);
    expect(card).not.toMatch(/\.send\(|\.steer\(/);
  });

  it('the pill is one row that never reflows: a cut text opens below it, a button never shrinks (end review r8)', () => {
    const css = read(`${superDir}/SuperSurface.css`).replace(/\/\*[\s\S]*?\*\//g, '');
    const rule = (sel: string) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
    expect(rule('.super-queue-head')).toMatch(/flex-wrap: nowrap;/);
    expect(css).not.toMatch(/\.super-queue-head:(hover|focus-within)\s*\{[^}]*flex-wrap/);
    expect(css).not.toMatch(/:(hover|focus-within) \.super-queue-text\s*\{/);
    expect(rule('.super-queue-text')).toMatch(/flex: 1 1 0; min-width: 10ch;[^}]*text-overflow: ellipsis; white-space: nowrap;/);
    expect(rule('.super-queue-who')).toMatch(/flex: 0 1 auto; min-width: 6ch;/);
    expect(rule('.super-queue-btn')).toMatch(/flex: none;/);
    expect(rule('.super-queue-actions')).toMatch(/flex: none;/);
    expect(rule('.super-queue-btn--option')).not.toMatch(/flex|min-width/);
    // Options at full width or not at all, measured before paint and on resize, never on hover.
    expect(strip).toMatch(/const next = optionsFit\(fitRef\.current, fitKey, band\.clientWidth, el\.scrollWidth - el\.clientWidth, showRef\.current\);/);
    // Keyed on the row's content (a change inside a full-width pill resizes no box), and run
    // again on every show/hide, before paint (end review r8, round 5).
    expect(strip).toMatch(/\[answerKey, titleFor\(head\?\.sessionId \?\? ''\), waiting > 1 \? waiting - 1 : 0, t\('super\.queue\.reply'\), t\('super\.queue\.answer'\)\]\.join\(/);
    expect(strip).toMatch(/\}, \[fitKey, showOptions\]\);/);
    expect(strip).toMatch(/useLayoutEffect\(\(\) => \{\n\s*const el = headRef\.current;/);
    expect(strip).toMatch(/ro\.observe\(band\);\n\s*ro\.observe\(el\);/);
    expect(strip).toMatch(/<button type="button" className="super-queue-btn super-queue-btn--reply" onClick=\{onReplyToSuper\}>/);
    expect(css).toMatch(/\.super-queue-head:hover \.super-queue-full,\n\.super-queue-head:focus-within \.super-queue-full \{ display: block; \}/);
    expect(rule('.super-queue-full')).toMatch(/position: absolute;[^}]*top: 100%;/);
    // Only a CUT text gets the overlay, measured on resize; the option buttons carry their label.
    expect(strip).toMatch(/const measure = \(\) => setCut\(el\.scrollWidth > el\.clientWidth \+ 1\);/);
    expect((strip.match(/return \(\) => \{ live = false; ro\.disconnect\(\); \};/g) ?? []).length).toBe(2);
    expect((strip.match(/void document\.fonts\?\.ready\.then\(\(\) => \{ if \(live\) measure\(\); \}\);/g) ?? []).length).toBe(2);
    expect(strip).toMatch(/\{cut && <span className="super-queue-full" aria-hidden="true">/);
  });

  it('the queue dot is decoration; its meaning rides in the button\'s accessible name', () => {
    const btn = read(`${superDir}/HandoverButton.tsx`);
    expect(btn).toMatch(/aria-label=\{dot \? `\$\{label\}, \$\{t\('super\.button\.queueDot'\)\}` : label\}/);
    expect(btn).toMatch(/<span className="super-handover-btn-dot" aria-hidden="true" \/>/);
    expect(btn).not.toMatch(/<span[^>]*aria-label/);
  });

  it('every lookup of the record\'s children by an id from a frame or the server is an own-key check', () => {
    // A bracket read is allowed only right behind its own hasOwnKey guard.
    for (const line of surface.split('\n').filter((l) => /\.(children|notes)\[/.test(l))) {
      expect(line).toMatch(/hasOwnKey\([^)]*\)/);
    }
    expect(surface).toMatch(/st\.enabled && hasOwnKey\(st\.children, claudeId\)/);
    expect(surface).toMatch(/if \(!hasOwnKey\(st\.children, child\)\) return \{ ok: false, error: 'not_a_child' \}/);
    expect(surface).toMatch(/!hasOwnKey\(superStateRef\.current\?\.children, c\.ref\)/);
    const model = read(`${superDir}/superHandover.ts`);
    expect(model).not.toMatch(/\.children\[/);
  });
});

describe('the window rules (D10, AC12)', () => {
  it('agent cards make 0 network requests: they read the child\'s live session', () => {
    const card = read(`${superDir}/AgentCard.tsx`);
    const frame = read(`${superDir}/SuperContainer.tsx`);
    const live = read(`${superDir}/liveSession.ts`);
    for (const src of [card, frame, live]) expect(src).not.toMatch(/\bfetch\(|useApi|useQuery|api\.(get|post)|EventSource|WebSocket/);
    // The card reads the child's live model; card and frame follow the session in ONE shared frame
    // (liveSession.ts), the frame only on a status change (frameKeyOf), the tile on what it draws.
    expect(card).toMatch(/session\?\.getModel\(\)/);
    expect(live).toMatch(/s\.subscribe\(\(\) => inNextFrame\(check\)\)/);
    expect(live).toMatch(/requestAnimationFrame\(run\)/);
    expect(frame).toMatch(/useLiveSession\(liveChat, \(\) => frameKeyOf\(liveChat\)\)/);
    expect(card).toMatch(/useLiveSession\(session, \(\) => cardKeyOf\(session, false\)\)/);
    // The one clock follows pollMs (slower unfocused, doubled in Light mode).
    expect(card).toMatch(/pollMs\(30_000\)/);
  });

  it('exactly one centre slot and one shown slot: at most one mounted child chat besides the centre', () => {
    const src = read(`${superDir}/SuperSurface.tsx`);
    const frame = read(`${superDir}/SuperContainer.tsx`);
    // The rendered slot elements (JSX), not mentions in comments.
    expect((src.match(/<div className="super-slot" data-super-slot="centre" \/>/g) ?? []).length).toBe(1);
    expect((src.match(/data-super-slot="[a-z]+" \/>/g) ?? []).length).toBe(1);
    expect((frame.match(/<div className="super-slot" data-super-slot="shown" \/>/g) ?? []).length).toBe(1);
    expect((frame.match(/data-super-slot="[a-z]+" \/>/g) ?? []).length).toBe(1);
    // …rendered only by the ONE card the surface names as the shown slot, and only when large.
    expect(frame).toMatch(/if \(c\.kind === 'chat' && p\.shownSlot\) \{/);
    expect(src).toMatch(/shownSlot=\{shownCard\?\.id === c\.id\}/);
    expect(src).toMatch(/\['half', 'present', 'sheet'\]\.includes\(plan\.cards\[c\.id\]\?\.where \?\? ''\)/);
  });

  it('the sidebar folds while handed over through a hold that never writes the saved preference (F9)', () => {
    const hook = read(`${DASH}/hooks/useSidebarCollapse.ts`);
    const hold = hook.slice(hook.indexOf('export function holdSidebarCollapsed'), hook.indexOf('export function isSidebarHeld'));
    expect(hold).not.toMatch(/localStorage|setUserPref/);
    // The toggle is a no-op while held.
    expect(hook).toMatch(/if \(isSidebarHeld\(activeInstanceId\)\) return;\n\s*setUserPref/);
    expect(hook).toMatch(/collapsed: forced \|\| userPref \|\| held/);
    // Flipped in the SAME commit as the switch, released on take-back and on unmount (FE4).
    const hand = surface.slice(surface.indexOf('const handOver = useCallback'), surface.indexOf('const takeBack = useCallback'));
    expect(hand).toMatch(/flushSync\(\(\) => \{\n\s*holdSidebarCollapsed\(instanceId, true\);[\s\S]{0,200}setSuperView\('super'\);/);
    const back = surface.slice(surface.indexOf('const takeBack = useCallback'), surface.indexOf('const settleReversed'));
    expect(back).toMatch(/flushSync\(\(\) => \{\n\s*holdSidebarCollapsed\(instanceId, false\);[\s\S]{0,120}setSuperView\('panes'\);/);
    expect(surface).toMatch(/useLayoutEffect\(\(\) => \{ holdSidebarCollapsed\(instanceId, handedOver\); \}, \[instanceId, handedOver\]\);/);
    expect(surface).toMatch(/useLayoutEffect\(\(\) => \(\) => holdSidebarCollapsed\(instanceId, false\), \[instanceId\]\);/);
  });

  it('the hand-over flights land on the stage plan measured at the folded width (FE4)', () => {
    const flight = surface.slice(surface.indexOf('const startFlight = (stage?'), surface.indexOf('const onStageReady = useCallback'));
    expect(flight).toMatch(/last = onStage\(stage\.plan\.centre\)/);
    expect(flight).toMatch(/cp\.where === 'others' \? stage\.plan\.othersRect : cp\.rect/);
    expect(surface).toMatch(/onStageReady=\{onStageReady\}/);
    const stage = ['SuperSurface.tsx', 'useStageDrag.ts', 'StageMotion.tsx'].map((f) => read(`${superDir}/${f}`)).join('\n');
    // Ready only once the measured size is the rendered one, and once per mount.
    expect(stage).toMatch(/if \(el\.clientWidth !== size\.width \|\| el\.clientHeight !== size\.height\) return;/);
    expect(stage).toMatch(/readyRef\.current = true;\n\s*props\.onStageReady/);
  });

  it('a drop never reorders the record; the card dropped last is lifted on top for the session', () => {
    const stage = ['SuperSurface.tsx', 'useStageDrag.ts', 'StageMotion.tsx'].map((f) => read(`${superDir}/${f}`)).join('\n');
    expect(stage).not.toMatch(/order: 'last'/);
    expect(stage).toMatch(/onLayout\(\{ cards: \[\{ id, pos: posFromRect\(p\.free, r\), place: 'float' \}\] \}\);\n\s*liftOnTop\(id\);/);
  });

  it('a re-render that draws the same stage never restarts a running motion (FE2)', () => {
    const stage = ['SuperSurface.tsx', 'useStageDrag.ts', 'StageMotion.tsx'].map((f) => read(`${superDir}/${f}`)).join('\n');
    expect(stage).toMatch(/if \(prev\.dragId === this\.props\.dragId && \(prev\.plan === this\.props\.plan \|\| samePlan\(prev\.plan, this\.props\.plan\)\)\) return null;/);
  });

  it('a second press while the hand-over request is out reverses as soon as the flight starts (AC Motion)', () => {
    const hand = surface.slice(surface.indexOf('const handOver = useCallback'), surface.indexOf('const takeBack = useCallback'));
    expect(hand).toMatch(/if \(superBusyRef\.current\) \{ reverseQueuedRef\.current = !reverseQueuedRef\.current; return; \}/);
    expect(hand).toMatch(/if \(reverseQueuedRef\.current\) \{ reverseQueuedRef\.current = false; settleReversedRef\.current\('in'\); \}/);
    const flight = surface.slice(surface.indexOf('const startFlight = (stage?'), surface.indexOf('const onStageReady = useCallback'));
    expect(flight).toMatch(/if \(reverseQueuedRef\.current\) \{ reverseQueuedRef\.current = false; run\.reverse\(\); \}/);
  });

  it('owner edits are patches kept over every push until the server echoes them (F3, §0 C3)', () => {
    const edit = surface.slice(surface.indexOf('const editSuperLayout = useCallback'), surface.indexOf('const askAboutCard = useCallback'));
    expect(edit).toMatch(/pendingPatchesRef\.current = \[\.\.\.pendingPatchesRef\.current, patch\]/);
    expect(edit).toMatch(/applyLayoutPatch\(prev, patch\)/);
    expect(edit).toMatch(/postSuperLayout\(scopedApi, patch\)/);
    // A save that did not land (refused, or no state answered) drops the patch and re-reads
    // the record: the screen never keeps an edit the server does not have (end review r8).
    expect(edit).toMatch(/const notSaved = \(why: unknown\) => \{\n\s*settle\(\);/);
    expect(edit).toMatch(/fetchSuperState\(scopedApi\)\.then\(\(st\) => \{ if \(st\) setSuperState\(withPendingEdits\(st\)\); \}\)/);
    expect(edit).toMatch(/if \(!st\) \{ notSaved\('no state in the answer'\); return; \}/);
    expect(edit).toMatch(/\n\s*notSaved,\n\s*\);/);
    expect(surface).toMatch(/if \(st\) setSuperState\(withPendingEdits\(st\)\);\n\s*\};/);
    expect(surface).toMatch(/pendingPatchesRef\.current\.filter\(\(p\) => !patchEchoed\(st, p\)\)/);
    const api = read(`${superDir}/superApi.ts`);
    expect(api).toMatch(/api\.post<\{ state\?: unknown \}>\('\/super\/layout', patch\)/);
  });

  it('asking about a card appends one @card reference to the Super Agent draft and writes nothing (O11)', () => {
    const ask = surface.slice(surface.indexOf('const askAboutCard = useCallback'), surface.indexOf('// ── The hand-over and the take-back'));
    expect(ask).toMatch(/if \(!cs \|\| cs\.status === 'closed'\) return;/);
    expect(ask).toMatch(/cs\.sendText\(cardReference\(id, title, cs\.getModel\(\)\.draft\)\)/);
    expect(ask).not.toMatch(/postSuperLayout|editSuperLayout/);
    expect(surface).toMatch(/onAskAbout=\{askAboutCard\}/);
    const stage = ['SuperSurface.tsx', 'useStageDrag.ts', 'StageMotion.tsx'].map((f) => read(`${superDir}/${f}`)).join('\n');
    // A drop on the centre asks; it posts no layout.
    expect(stage).toMatch(/if \(drop && h === 'centre'\) actions\.onAskAbout\(id\);\n\s*else if/);
  });

  it('a handed-over child\'s chat is read-only; the Super Agent\'s own has no mode menu', () => {
    expect(surface).toMatch(/readOnly=\{marked\.has\(cs\.claudeId\)\}/);
    const pane = read(`${SLEEPY}/ChatPane.tsx`);
    expect(pane).toMatch(/\) : readOnly \? \(\s*<SuperReadOnlyLine \/>/);
    expect(pane).toMatch(/onModeChange=\{bare \|\| mode === 'super' \? undefined : onModeChange\}/);
    const host = read(`${SLEEPY}/ChatPaneHost.tsx`);
    expect(host).toMatch(/readOnly=\{readOnly\}/);
  });

  it('no backdrop-filter; the only endless motion is a status animation through the contract, and nothing rotates', () => {
    // Declarations only: a comment may name what the file avoids.
    const css = read(`${superDir}/SuperSurface.css`).replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/backdrop-filter\s*:/);
    expect(css).toMatch(/animation: var\(--dc-motion-status-name, super-dot-breathe\)/);
    expect(css).toMatch(/animation-play-state: var\(--dc-motion-play, running\)/);
    expect(css).not.toMatch(/rotate\(/);
  });

  it('no super module polls or animates endlessly from script', () => {
    for (const f of readdirSync(join(ROOT, superDir))) {
      const src = read(`${superDir}/${f}`);
      if (!/\.tsx?$/.test(f)) continue;
      expect(src, f).not.toMatch(/iterations\s*:\s*Infinity/);
      expect(src, f).not.toMatch(/setInterval\((?![^)]*pollMs)/);
    }
  });

  /** A fake clock + scheduler for the lease: `advance(ms)` runs the timers that come due. */
  function fakeLease() {
    let now = 0;
    const posts: number[] = [];
    let timers: Array<{ at: number; fn: () => void; id: number }> = [];
    let seq = 0;
    const lease = createActivityLease(() => { posts.push(now); }, () => now, ACTIVITY_POST_GAP_MS, {
      schedule: (fn, ms) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
      cancel: (h) => { timers = timers.filter((x) => x.id !== h); },
    });
    const advanceTo = (t: number) => {
      for (;;) {
        const due = timers.filter((x) => x.at <= t).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((x) => x !== due);
        now = due.at;
        due.fn();
      }
      now = t;
    };
    return { lease, posts, advanceTo, pendingTimers: () => timers.length };
  }

  it('the activity lease: nothing without keystrokes, at most one POST per 5 s', () => {
    expect(ACTIVITY_POST_GAP_MS).toBe(5_000);
    const f = fakeLease();
    f.advanceTo(60_000);
    expect(f.posts).toEqual([]);          // nobody typed (a hidden window posts nothing)
    expect(f.pendingTimers()).toBe(0);
  });

  it('a burst of keystrokes over 1.8 s posts exactly twice: at the first keystroke and 5 s later (the trailing edge)', () => {
    const f = fakeLease();
    // 45 keystrokes, 40 ms apart.
    for (let k = 0; k < 45; k++) { f.advanceTo(k * 40); f.lease.typed(); }
    expect(f.posts).toEqual([0]);
    f.advanceTo(30_000);
    expect(f.posts).toEqual([0, 5_000]);
    // The server's 15 s lease now runs to 20 s, past the last keystroke (1.76 s) + 15 s.
    expect(f.posts[f.posts.length - 1] + 15_000).toBeGreaterThanOrEqual(44 * 40 + 15_000);
  });

  it('a single keystroke posts once; a keystroke 6 s after a post posts at once', () => {
    const f = fakeLease();
    f.lease.typed();
    f.advanceTo(6_000);
    expect(f.posts).toEqual([0]);
    f.lease.typed();
    expect(f.posts).toEqual([0, 6_000]);
    f.advanceTo(30_000);
    expect(f.posts).toEqual([0, 6_000]);
  });

  it('dispose cancels a pending trailing post, and the surface disposes it on take-back / unmount', () => {
    const f = fakeLease();
    f.lease.typed();
    f.advanceTo(1_000); f.lease.typed();
    expect(f.pendingTimers()).toBe(1);
    f.lease.dispose();
    f.advanceTo(30_000);
    expect(f.posts).toEqual([0]);
    f.lease.typed();
    expect(f.posts).toEqual([0]);
    expect(surface).toMatch(/if \(!superState\?\.enabled\) return undefined;\s*const lease = createActivityLease\(/);
    expect(surface).toMatch(/return \(\) => \{\s*lease\.dispose\(\);/);
    // Wired to the Super Agent's composer only, and only while handed over.
    expect(surface).toMatch(/cs\.setDraftListener\(\(\) => \{ if \(superStateRef\.current\?\.enabled\) superLeaseRef\.current\?\.typed\(\); \}\)/);
  });

  it('the recap trigger hangs off onWindowActivity and the pure shouldRecap', () => {
    expect(surface).toMatch(/return onWindowActivity\(\(next, prev, change\) => \{\s*if \(shouldRecap\(prev\.focused, next\.focused, change\.unfocusedMs/);
  });

  it('the state is pushed, never polled: one GET for the first paint, then super_state', () => {
    const api = read(`${superDir}/superApi.ts`);
    expect(api).not.toMatch(/setInterval|refetchInterval/);
    // The one timer is the activity lease's trailing post (a keystroke happened), never a poll.
    expect((api.match(/setTimeout\(/g) ?? []).length).toBe(1);
    expect(api).toMatch(/schedule: \(fn, ms\) => setTimeout\(fn, ms\)/);
    expect(surface).toMatch(/superSignalRef\.current = \(signal\) => \{\s*if \(signal\.kind !== 'state'\) return;\s*const st = readSuperStateView\(signal\.state\);/);
  });
});

describe('stable hooks for the lead\'s verify script', () => {
  it('every piece the verify drives carries its test id', () => {
    const all = readdirSync(join(ROOT, superDir)).filter((f) => f.endsWith('.tsx')).map((f) => read(`${superDir}/${f}`)).join('\n');
    for (const id of ['super-handover-btn', 'super-surface', 'super-container', 'super-job-bar', 'super-queue-head', 'super-terminals-row']) {
      expect(all, id).toContain(`data-testid="${id}"`);
    }
    expect(all).toMatch(/data-kind=\{c\.kind\}/);
    expect(all).toMatch(/data-container-id=\{c\.id\}/);
    expect(all).toMatch(/data-super-motion=\{motion\}/);
  });
});

describe('TR + EN for every new string; the button reads the owner\'s words', () => {
  const i18n = read('dashboard/src/context/I18nContext.tsx');
  const en = i18n.slice(0, i18n.indexOf('const TR_PARTIAL'));
  const tr = i18n.slice(i18n.indexOf('const TR_PARTIAL'));

  it('the button: "Süper Ajana devret" / "Hand over to the Super Agent", "Geri al" / "Take it back"', () => {
    expect(en).toContain("'super.button.handOver': 'Hand over to the Super Agent'");
    expect(en).toContain("'super.button.takeBack': 'Take it back'");
    expect(tr).toContain("'super.button.handOver': 'Süper Ajana devret'");
    expect(tr).toContain("'super.button.takeBack': 'Geri al'");
    // The agent is Claude in the cape.
    expect(en).toContain("'super.centre.name': 'Claude'");
  });

  it('every super.* key the window uses exists in English AND Turkish', () => {
    const files = [
      ...readdirSync(join(ROOT, superDir)).filter((f) => f.endsWith('.tsx')).map((f) => `${superDir}/${f}`),
      `${SLEEPY}/ChatPane.tsx`, `${SLEEPY}/AgentSurface.tsx`,
    ];
    const keys = new Set<string>();
    for (const f of files) for (const m of read(f).matchAll(/t\('(super\.[a-zA-Z.]+)'\)/g)) keys.add(m[1]);
    // Keys built from a value: every value the code can produce.
    for (const k of ['saved', 'starting', 'working', 'asking', 'ready', 'ended']) keys.add(`super.card.state.${k}`);
    for (const k of ['question', 'idle', 'gone', 'recap', 'handover', 'other']) keys.add(`super.event.${k}`);
    for (const k of ['chat', 'insight', 'task', 'knowledge', 'whiteboard', 'board', 'web', 'image', 'group']) keys.add(`super.tile.kind.${k}`);
    expect(keys.size).toBeGreaterThan(30);
    for (const k of keys) {
      expect(en, `EN ${k}`).toContain(`'${k}':`);
      expect(tr, `TR ${k}`).toContain(`'${k}':`);
    }
  });
});
