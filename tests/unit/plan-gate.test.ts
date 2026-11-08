import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { planDecide, planLink, planOpen, planPacket, planRecord, planStatus } from '../../src/cli/commands/plan.js';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { handleTasksReadiness } from '../../src/server/routes/tasks.js';
import { planGateGaps } from '../../src/lib/plan-ledger.js';
import { plansDir, readPlanLedgers, reviewPath } from '../../src/lib/plan-store.js';
import { makePlanVault, makeReadyTask, reviewText, writePlan, type PlanVault, type ReviewFinding } from '../helpers/plan-vault.js';

/**
 * The plan gate on every door into Develop (criterion 10): `plan link`, `tasks ready` and the
 * Develop button's `GET /tasks/:slug/readiness` ask the same `planGateGaps`.
 */

let v: PlanVault;
let prevCwd: string;
let out: string[];

beforeEach(() => {
  v = makePlanVault();
  prevCwd = process.cwd();
  process.chdir(v.project);
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(prevCwd);
  v.cleanup();
});

const E = 'edge-cases';

async function tasksReady(slug: string): Promise<{ code: number; text: string }> {
  out = [];
  process.exitCode = 0;
  const program = new Command();
  program.exitOverride();
  registerTasksCommand(program);
  await program.parseAsync(['node', 'dreamcontext', 'tasks', 'ready', slug]);
  const code = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { code, text: out.join('\n') };
}

async function readiness(slug: string): Promise<{ status: number; body: any }> {
  let status = 0;
  let body: any = null;
  const res = {
    writeHead(c: number) { status = c; },
    end(d: string) { body = JSON.parse(d); },
    setHeader() {},
  } as unknown as ServerResponse;
  await handleTasksReadiness({ method: 'GET', headers: {} } as unknown as IncomingMessage, res, { slug }, v.root);
  return { status, body };
}

async function link(plan: string): Promise<string> {
  try { return await planLink(v.deps, plan); } catch (err) { return `REFUSED ${(err as Error).message}`; }
}

/** All three doors at once. */
async function doors(slug: string, plan: string): Promise<{ ready: boolean; route: boolean; link: boolean; routeGaps: any[] }> {
  const r = await tasksReady(slug);
  const route = await readiness(slug);
  const l = await link(plan);
  return { ready: r.code === 0, route: route.body.ready, link: !l.startsWith('REFUSED'), routeGaps: route.body.gaps };
}

async function round(plan: string, reviews: { critic?: ReviewFinding[]; [E]?: ReviewFinding[] }, changes: string[] = [], closedWhy: Record<string, string> = {}) {
  const before = planStatus(v.deps, plan).state;
  const n = before.round + 1;
  writePlan(v, plan, n, changes);
  await planPacket(v.deps, plan, 'critic');
  await planPacket(v.deps, plan, E);
  for (const lens of ['critic', E] as const) {
    const listed = reviews[lens] ?? [];
    const keep = new Set(listed.map((f) => f.id).filter(Boolean));
    const close = before.open.filter((f) => f.lens === lens && !keep.has(f.id)).map((f) => [f.id, closedWhy[f.id] ?? 'fixed'] as [string, string]);
    writeFileSync(reviewPath(v.root, plan, n, lens), reviewText(listed, close));
    await planRecord(v.deps, plan, lens, {});
  }
  return planStatus(v.deps, plan).state;
}

async function openPlan(plan: string): Promise<string> {
  const slug = await makeReadyTask(v, `Task for ${plan}`);
  await planOpen(v.deps, plan, { task: slug, goal: 'Ship it', lenses: `critic,${E}` });
  return slug;
}

describe('the plan gate', () => {
  it('open Critical, unaccepted Major and not-done refuse all three doors with {field:"plan"} gaps; an accepted Major passes all three', async () => {
    const slug = await openPlan('g');
    let s = await round('g', { critic: [{ cls: 'auth', level: 'Critical' }], [E]: [{ cls: 'retry' }] });
    const gaps = planGateGaps(readPlanLedgers(v.root), slug);
    expect(gaps.every((g) => g.field === 'plan')).toBe(true);
    expect(gaps.map((g) => g.problem).join('\n')).toMatch(/open Critical finding r1-critic-1[\s\S]*open Major finding r1-edge-cases-1[\s\S]*not done[\s\S]*dreamcontext plan status g/);
    const d1 = await doors(slug, 'g');
    expect(d1).toMatchObject({ ready: false, route: false, link: false });
    expect(d1.routeGaps.filter((g: any) => g.field === 'plan').length).toBe(3);
    expect(out.join('\n')).toBeTruthy();
    const ready = await tasksReady(slug);
    expect(ready.text).toMatch(/plan status/);

    s = await round('g', { [E]: [{ id: 'r1-edge-cases-1', cls: 'retry' }] });
    expect(s.open.map((f) => f.id)).toEqual(['r1-edge-cases-1']);
    expect(await doors(slug, 'g')).toMatchObject({ ready: false, route: false, link: false });
    await planDecide(v.deps, 'g', 'accept', { finding: 'r1-edge-cases-1', note: 'owner accepts the retry gap' });
    expect(planStatus(v.deps, 'g').state.done).toBe(true);
    const d2 = await doors(slug, 'g');
    expect(d2).toMatchObject({ ready: true, route: true, link: true });
  });

  it('a task no ledger names gets no new gap; a corrupt ledger is one gap for every task, never a 500', async () => {
    const slug = await makeReadyTask(v, 'Unplanned');
    expect(planGateGaps(readPlanLedgers(v.root), slug)).toEqual([]);
    expect((await readiness(slug)).body.ready).toBe(true);
    mkdirSync(join(plansDir(v.root), 'broken'), { recursive: true });
    writeFileSync(join(plansDir(v.root), 'broken', 'ledger.json'), '{"v":1,');
    const r = await readiness(slug);
    expect(r.status).toBe(200);
    expect(r.body.ready).toBe(false);
    expect(r.body.gaps).toEqual([expect.objectContaining({ field: 'plan', problem: expect.stringMatching(/unreadable plan ledger.*broken.*move that plan folder out of tmp\/plans/) })]);
    expect((await tasksReady(slug)).code).toBe(1);
  });

  it('after a split the source is refused until a round completes in which every moved id is closed cut; the follow-up holds one criterion per moved finding', async () => {
    const slug = await openPlan('s');
    await round('s', { critic: [{ cls: 'keep', level: 'Major' }, { cls: 'picture' }], [E]: [{ cls: 'picture', level: 'Critical' }] });
    const follow = await v.backend.create({ name: 'Pictures later' });
    await planDecide(v.deps, 's', 'split', { note: 'böl', task: follow.slug, classes: ['picture'] });
    // Follow-up task: one criterion per moved finding, naming its raw review.
    const ac = (await v.backend.get(follow.slug))!.acceptance_criteria;
    expect(ac).toMatch(/Resolve plan finding r1-critic-2 \(Major, picture\):.*raw review tmp\/plans\/s\/r1-critic\.md/);
    expect(ac).toMatch(/Resolve plan finding r1-edge-cases-1 \(Critical, picture\):.*raw review tmp\/plans\/s\/r1-edge-cases\.md/);
    expect(ac.match(/Resolve plan finding/g)).toHaveLength(2);
    // The post-split round needs the split line.
    writePlan(v, 's', 2);
    await expect(planPacket(v.deps, 's', 'critic')).rejects.toThrow(/split: picture \|/);
    // A moved id re-stated there keeps the source refused and counts its class.
    let s = await round('s', { critic: [{ id: 'r1-critic-2', cls: 'picture' }] }, ['split: picture | the picture part'], { 'r1-critic-1': 'fixed', 'r1-edge-cases-1': 'cut' });
    expect(s.open.map((f) => f.id)).toEqual(['r1-critic-2']);
    expect(s.classCounts.picture).toBe(2);
    expect(planStatus(v.deps, 's').json.flags).toEqual(expect.arrayContaining([expect.stringMatching(/r1-critic-2 was re-stated after the split/)]));
    expect(await doors(slug, 's')).toMatchObject({ ready: false, route: false, link: false });
    // Closed `cut` by its owning lens: the source passes all three doors.
    s = await round('s', {}, ['redesign: picture | gone from this plan'], { 'r1-critic-2': 'cut' });
    expect(s.done).toBe(true);
    expect(await doors(slug, 's')).toMatchObject({ ready: true, route: true, link: true });
    // Nothing transferred: no ledger names the follow-up task.
    expect(readPlanLedgers(v.root).filter((r) => r.ok && r.ledger.task === follow.slug)).toEqual([]);
  });

  it('abandon with an open Critical is refused unless --cancel-task; an abandoned ledger is skipped; a live un-done ledger blocks a second open', async () => {
    const slug = await openPlan('a');
    await round('a', { critic: [{ cls: 'auth', level: 'Critical' }] });
    await expect(planOpen(v.deps, 'a2', { task: slug, goal: 'again', lenses: `critic,${E}` })).rejects.toThrow(/already has a live plan "a"/);
    await expect(planDecide(v.deps, 'a', 'abandon', { note: 'drop it' })).rejects.toThrow(/open Critical \(r1-critic-1\) cannot be dropped/);
    expect(await planDecide(v.deps, 'a', 'abandon', { note: 'drop it all', cancelTask: true })).toMatch(/cancelled/);
    expect((await v.backend.get(slug))!.status).toBe('cancelled');
    expect(planGateGaps(readPlanLedgers(v.root), slug)).toEqual([]);
    await expect(planPacket(v.deps, 'a', 'critic')).rejects.toThrow(/abandoned/);
    await expect(planLink(v.deps, 'a')).rejects.toThrow(/abandoned/);
    // Abandoned frees the task for a new plan.
    expect(await planOpen(v.deps, 'a2', { task: slug, goal: 'again', lenses: `critic,${E}` })).toMatch(/opened/);
  });

  it('link writes the final snapshot\'s block; the same sha is a no-op, a new sha replaces the block', async () => {
    const slug = await openPlan('l');
    await round('l', {});
    expect(await planLink(v.deps, 'l')).toMatch(/Linked l/);
    let td = (await v.backend.get(slug))!.technical_details;
    expect(td).toMatch(/<!-- dreamcontext-plan:l sha:[0-9a-f]{16} -->/);
    expect(td).toContain('- contract text r1');
    expect(td).toContain('Edit src/lib/thing.ts');
    expect(await planLink(v.deps, 'l')).toMatch(/Already linked/);
    await planDecide(v.deps, 'l', 'add', { note: 'one more screen' });
    await round('l', {});
    expect(await planLink(v.deps, 'l')).toMatch(/Re-linked/);
    td = (await v.backend.get(slug))!.technical_details;
    expect(td).toContain('- contract text r2');
    expect(td).not.toContain('- contract text r1');
    expect(td.match(/<!-- dreamcontext-plan:l /g)).toHaveLength(1);
    expect(readFileSync(join(v.root, 'state', `${slug}.md`), 'utf-8')).toContain('Edit src/lib/thing.ts');
  });
});
