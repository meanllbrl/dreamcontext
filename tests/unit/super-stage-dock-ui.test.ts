import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dockTiles } from '../../dashboard/src/components/sleepy/super/superLayout';
import { cardAskLine, lastCommandOf } from '../../dashboard/src/components/sleepy/super/superHandover';

/**
 * super-v3 W1 Lane B, the stage's UI seams: the Dock's tile order (D11), what a live card shows
 * (frame 03: last command; frame 10c: the question once with "Asked in the chat · Show"), the red
 * light's sheet only while a job is busy (D2), Undo wired to the owner's resume door, the head's
 * pill + Stage / List switch (D13) and the agenda's K13 props. The server half of Undo (the card
 * and the agenda line come back with their earlier status and `by`) is super-owner-doors.test.ts.
 * The rendered proof is the super-v3.mjs frames in the task log.
 */
const SRC = (f: string) => readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', ...f.split('/')), 'utf-8');
const SURFACE = SRC('components/sleepy/super/SuperSurface.tsx');
const CONTAINER = SRC('components/sleepy/super/SuperContainer.tsx');
const CARD = SRC('components/sleepy/super/AgentCard.tsx');
const LIST = SRC('components/sleepy/super/SuperListView.tsx');

describe('Dock tile order (D11)', () => {
  it('Today, needs you, Team, jobs, minimized, Pool, left to right', () => {
    const plan = dockTiles({ today: 'agenda', needs: ['n1', 'n2'], members: ['m1'], jobs: ['j1', 'j2', 'j3'], minis: ['p1'], pool: 2 }, { width: 1356, height: 828 }, { tight: true });
    expect(plan.tiles.map((t) => t.kind)).toEqual(['today', 'needs', 'needs', 'member', 'job', 'job', 'job', 'mini', 'pool']);
    const xs = plan.tiles.map((t) => t.rect.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });
  it('a waiting job and a waiting member carry the pink tone and a badge', () => {
    expect(SURFACE).toMatch(/const waits = state\.queue\.filter\(\(q\) => q\.sessionId === c\.ref && needsOwner\(q\)\)\.length;/);
    expect(SURFACE).toContain("...(waits ? { badge: waits } : {})");
    expect(SURFACE).toContain("const tone = card?.approval ? 'asking' as const");
  });
});

describe('the live card (frames 03, 10c)', () => {
  it('the last command: a shell command whole, a file edit by its short path', () => {
    expect(lastCommandOf([{ kind: 'tool', name: 'Bash', input: { command: 'grep "session expired" src/auth' } }])).toBe('grep "session expired" src/auth');
    expect(lastCommandOf([{ kind: 'tool', name: 'Edit', input: { file_path: '/w/acme/src/screens/CheckoutScreen.tsx' } }])).toBe('edit …/screens/CheckoutScreen.tsx');
    expect(lastCommandOf([{ kind: 'text', text: 'hi' }])).toBe('');
  });
  it('the question once, in one line; a permission reads the child\'s own command instead', () => {
    expect(cardAskLine({ kind: 'ask', ask: { questions: [{ question: 'Which yearly price?', options: [] }] } })).toBe('Which yearly price?');
    expect(cardAskLine({ kind: 'owner', ownerText: 'Run   the deploy\nyourself' })).toBe('Run the deploy yourself');
    expect(cardAskLine({ kind: 'permission', ownerText: 'x' })).toBe('');
  });
  it('Show reveals the question in the chat and is a live control on an inert card', () => {
    expect(CARD).toContain('revealQuestion(item.id)');
    expect(CARD).toMatch(/onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/);
    expect(SRC('components/sleepy/super/SuperSurface.css')).toContain(".super-card-frame[data-where='float'] .super-card-show { pointer-events: auto; }");
  });
  it('a working card walks a light, never a percent (D4)', () => {
    expect(CARD).toContain("status.kind === 'working' && !asksOwner && <div className=\"super-card-walk\"");
    expect(CARD).not.toMatch(/%\s*`|progress/i);
  });
  it('the card the agenda filters on is outlined (K13)', () => {
    expect(CARD).toContain("useJobFilter() === child?.sessionId");
  });
});

describe('the red light (D2) and Undo', () => {
  it('the sheet only when the job works, asks or runs background work; idle ends at once with Undo', () => {
    expect(CONTAINER).toContain('return kind === \'working\' || kind === \'asking\' || session.hasLiveWork();');
    expect(CONTAINER).toContain("asksOnClose ? (childBusy ? setCloseAsk((v) => !v) : props.onEndSession(c.id, false, true))");
  });
  it('Undo is offered only for the idle close and goes to the owner door', () => {
    expect(SURFACE).toContain('if (undoable && props.onUndoEnd) setUndoEnd(');
    expect(SRC('components/sleepy/AgentSurface.tsx')).toMatch(/postSuperResume/);
  });
  it('the agenda\'s Stop runs the same red light on that job', () => {
    expect(CONTAINER).toContain("stopRef.current = () => (childBusy ? setCloseAsk(true) : props.onEndSession(c.id, false, true));");
    expect(SURFACE).toContain('onStop={remote ? undefined : stopJob}');
  });
});

describe('the head (D13) and the agenda seams (K13)', () => {
  it('the pill counts from the record and needs-you jumps to queueHead\'s item', () => {
    expect(SURFACE).toContain('needs={ownerQueueCount(state)}');
    expect(SURFACE).toContain('const head = queueHead(state); if (head) revealQuestion(head.id);');
    expect(SURFACE).toContain("rowOf(c, jobLook.live(sid)) === 'working'");
  });
  it('List is a window-only view (Today beside the chat), remembered per window, never written', () => {
    expect(SURFACE).toContain("listAgenda ? { mode: 'half', card: listAgenda }");
    expect(LIST).toContain('sessionStorage');
    expect(SURFACE).not.toMatch(/onLayout\([^)]*listAgenda/);
  });
  it('the agenda gets docked, selected, onSelect, onStop and onAsk', () => {
    for (const p of ['docked={', 'selected={remote ? null : jobFilter}', 'onSelect={remote ? undefined : setJobFilter}', 'onAsk={remote ? undefined : actions.onAskAbout}']) expect(SURFACE).toContain(p);
  });
});
