/**
 * The owner's notes of 2026-10-31 on the new shell's drawer: a job the Super Agent gave a member is
 * not on it; no closed Chat row and no empty screen; a click on another project lands in one step.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildDrawerRows, teamRowsOf, type DrawerProjectInput } from '../../dashboard/src/components/layout/newshell/drawerModel';
import { buildRoster, type TeamAgent } from '../../dashboard/src/components/aiteam/teamModel';
import { arrivalCovers, landsOnChat } from '../../dashboard/src/lib/drawerIntents';

const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf-8');
const project = (name: string, o: Partial<DrawerProjectInput> = {}): DrawerProjectInput => ({
  name, logo: false, logoStamp: null, mounted: false, asleep: false, otherWindow: false, rollup: null, ...o,
});
const win = (id: string, tabs: number, o: Record<string, number> = {}) => ({ id, name: id, working: 0, asking: 0, flagged: 0, other: tabs, tabs, ...o });
const facts = (windows: ReturnType<typeof win>[]) => ({ superOn: false, superSelected: false, chatOpen: false, team: [], windows, activeWindowId: windows[0]?.id });
const kinds = (r: { children: { kind: string }[] }) => r.children.map((c) => c.kind);

describe('New Chat instead of a closed window', () => {
  it('a mounted project whose windows are empty has one New Chat row, in place of every window row', () => {
    const [r] = buildDrawerRows({ projects: [project('a', { mounted: true })], activeVault: 'a', expanded: ['a'], facts: { a: facts([win('main', 0), win('w2', 0)]) }, fanout: {} });
    expect(kinds(r)).toEqual(['super', 'new-chat']);
  });
  it('a far project with no saved tab has it too', () => {
    const [r] = buildDrawerRows({ projects: [project('a')], activeVault: null, expanded: ['a'], facts: {}, fanout: { a: { tabs: 0, superOn: false, team: [], windows: [{ id: 'main', name: 'Chat', tabs: 0 }] } } });
    expect(kinds(r)).toEqual(['super', 'new-chat']);
  });
  it('a window of saved (sleeping) tabs is not empty, whatever its live count says', () => {
    const [r] = buildDrawerRows({ projects: [project('a', { mounted: true })], activeVault: 'a', expanded: ['a'], facts: { a: facts([{ ...win('main', 3), other: 0 }, win('w2', 0)]) }, fanout: {} });
    expect(kinds(r)).toEqual(['super', 'window']);
  });
  it('says nothing before anything is read', () => {
    const [r] = buildDrawerRows({ projects: [project('a')], activeVault: null, expanded: ['a'], facts: {}, fanout: {} });
    expect(kinds(r)).toEqual(['super']);
  });
  it('a mounted project still restoring offers nothing', () => {
    const [r] = buildDrawerRows({ projects: [project('a', { mounted: true })], activeVault: 'a', expanded: ['a'], facts: { a: { superOn: false, superSelected: false, chatOpen: false, team: [] } }, fanout: {} });
    expect(kinds(r)).toEqual(['super']);
  });
  it('a failed read is not an empty project', () => {
    const [r] = buildDrawerRows({ projects: [project('a')], activeVault: null, expanded: ['a'], facts: {}, fanout: { a: { tabs: 0, superOn: false, team: [] } } });
    expect(kinds(r)).toEqual(['super']);
  });
});

describe("a Super Agent's job is not on the drawer", () => {
  const agent = { slug: 'desk', title: 'Desk', hasPhoto: false, roleLine: '', description: '', approvedForChat: true, approvedToRun: true, approvalReason: null, model: null, effort: null } as unknown as TeamAgent;
  const msg = (o: Record<string, unknown>) => ({ slug: 'desk', key: 'k', runId: 'r1', at: '2026-10-31T10:00:00Z', status: 'running', question: null, text: '', ask: null, newestId: '1', ...o });
  const working = (runId: string | null) => ({ desk: { since: 1, runId, queued: [] } });
  const rows = (messages: unknown[], w: unknown = {}) => teamRowsOf(buildRoster([agent], [], { messages, unreadBySlug: {}, runSlots: {}, working: w } as never));

  it('a job of the Super, running, leaves no row', () => {
    expect(rows([msg({ superJob: true })], working('r1'))).toEqual([]);
  });
  it("the owner's own run stays", () => {
    expect(rows([msg({})], working('r1')).map((r) => r.slug)).toEqual(['desk']);
  });
  it("the owner's run beside a Super job stays", () => {
    expect(rows([msg({ superJob: true }), msg({ runId: 'r2' })], working('r1')).map((r) => r.slug)).toEqual(['desk']);
  });
  it('a turn nobody can name stays: a row only leaves on proof', () => {
    expect(rows([msg({ superJob: true, status: 'ok' })], working(null)).map((r) => r.slug)).toEqual(['desk']);
    expect(rows([msg({ superJob: true, status: 'ok' })], working('other')).map((r) => r.slug)).toEqual(['desk']);
  });
  it('a question on a run that is not a Super job stays (the server ends a job at its question)', () => {
    expect(rows([msg({ status: 'ok', question: { id: 'q', text: '?', choices: [] } })]).map((r) => r.slug)).toEqual(['desk']);
  });
  it('the AI Team page still shows it working', () => {
    const [r] = buildRoster([agent], [], { messages: [msg({ superJob: true })], unreadBySlug: {}, runSlots: {}, working: working('r1') } as never);
    expect(r.status).toBe('working');
    expect(r.superOnly).toBe(true);
  });
});

describe('one step to what was clicked', () => {
  it('what lands on the chat area, and what does not', () => {
    expect(landsOnChat({ kind: 'super' })).toBe(true);
    expect(landsOnChat({ kind: 'new-window' })).toBe(true);
    expect(landsOnChat({ kind: 'open-window', windowId: 'x' })).toBe(true);
    expect(landsOnChat({ kind: 'member', slug: 'a', title: 'A' })).toBe(true);
    expect(landsOnChat({ kind: 'page', page: 'relations' })).toBe(false);
    expect(landsOnChat({ kind: 'close-window', windowId: 'x' })).toBe(false);
    expect(landsOnChat({ kind: 'move-window', windowId: 'x', before: null })).toBe(false);
  });
  it('the window queues before it brings the project forward', () => {
    const body = src('dashboard/src/components/layout/WindowChrome.tsx').split('const queueDrawerIntent =')[1];
    expect(body.indexOf('setPendingDrawerIntents')).toBeLessThan(body.indexOf('addTab(vault)'));
    expect(body.indexOf('setPendingDrawerIntents')).toBeLessThan(body.indexOf('activate(vault)'));
  });
  it('the surface takes it before the first paint', () => {
    expect(src('dashboard/src/components/sleepy/AgentSurface.tsx')).toMatch(/useLayoutEffect\(\(\) => \{\s*if \(!arrival \|\| !windowed\) return;\s*setExpanded\(true\);/);
  });
  it('the project already on screen is never covered while a click lands (owner 2026-11-07: a member row gave a blank white page)', () => {
    // Brought forward or still restoring: the plain wait covers what it would flash first.
    expect(arrivalCovers({ kind: 'member', slug: 'a', title: 'A' }, false)).toBe(true);
    expect(arrivalCovers({ kind: 'super' }, false)).toBe(true);
    // On screen and ready: it keeps its stage until the click has run, a member's and main's.
    expect(arrivalCovers({ kind: 'member', slug: 'a', title: 'A' }, true)).toBe(false);
    expect(arrivalCovers({ kind: 'super' }, true)).toBe(false);
    expect(arrivalCovers({ kind: 'new-window' }, true)).toBe(false);
    // A History pick never waits.
    expect(arrivalCovers({ kind: 'open-session', sessionId: 's' }, false)).toBe(false);
    const surface = src('dashboard/src/components/sleepy/AgentSurface.tsx');
    // The arrival reads the commit before the click's (a passive effect), and only then covers.
    expect(surface).toMatch(/useEffect\(\(\) => \{\s*shownReadyRef\.current = isActive && expanded && caps !== null && settingsReady && hydratedRef\.current && superKnownRef\.current;\s*\}\);/);
    expect(surface).toMatch(/if \(arrivalCovers\(arrival\.intent, shownReadyRef\.current\)\) setArriving\(arrival\.intent\.kind\);/);
    expect(surface).not.toMatch(/if \(arrival\.intent\.kind !== 'open-session'\) setArriving\(/);
  });
  it("a member lands on its own stage (plan-r10 1), a task intent included; the peek is transcripts only", () => {
    expect(landsOnChat({ kind: 'member', slug: 'a', title: 'A', task: 'some-task' })).toBe(true);
    const surface = src('dashboard/src/components/sleepy/AgentSurface.tsx');
    expect(surface).toMatch(/void openMemberStage\(intent\.slug, intent\.task\);/);
    expect(surface).toMatch(/setSuperView\('super'\);\s*setExpanded\(true\);/);
    expect(surface).toMatch(/\{windowed && superPeek && \(/);
    expect(surface).toMatch(/\{renderChildTranscript\(superPeek\.claudeId\)\}/);
    // The drawer marks the member's row while its stage shows, not main's.
    expect(surface).toMatch(/const peekMember = superView === 'super' \? memberOf\(activeSuperId\) : null;/);
  });
});

describe('a project is a job, the first project is the only job', () => {
  const flow = src('dashboard/src/pages/onboarding/Onboarding.tsx');
  it('no project yet: nothing to skip to', () => {
    expect(flow).toMatch(/\{purpose !== 'first-run' && !\(task && stage === 'handoff'\) && \(\s*<button[^>]*ob-skip/);
    const launcher = src('dashboard/src/pages/LauncherPage.tsx');
    expect(launcher).toContain("purpose={!newShell ? 'setup' : data && vaults.length === 0 ? 'first-run'");
  });
  it('the Mac step never traps a first run', () => {
    expect(flow).toMatch(/purpose === 'first-run' && stage === 'machine' && !welcoming[\s\S]*setStage\('project'\)/);
  });
  it('a project another window holds comes forward there, by the window that holds it', () => {
    expect(src('dashboard/src/pages/LauncherRoot.tsx')).toMatch(/const holder = findWindowForVault\(name\);\s*if \(holder && await focusWindow\(holder\)\) return;/);
  });
  it('an unread roster is no answer', () => {
    expect(src('dashboard/src/components/sleepy/AgentSurface.tsx')).toContain('if (!rosterUnread) setRosterKnown(true)');
  });
  it('an existing project opens as it is, never on a fresh chat', () => {
    expect(src('dashboard/src/components/layout/newshell/NewProjectFlow.tsx')).toContain("onLand(name, 'existing')");
    expect(src('dashboard/src/components/layout/WindowChrome.tsx')).toContain("how ? { kind: 'open-window' } : { kind: 'new-window' }");
  });
  it('from the drawer: a task, no steps, and Cancel', () => {
    expect(src('dashboard/src/components/layout/newshell/NewProjectFlow.tsx')).toContain('purpose="new-project"');
    expect(flow).toContain("welcoming || task ? <span aria-hidden=\"true\" /> : <StepDots stage={stage} />");
  });
});
