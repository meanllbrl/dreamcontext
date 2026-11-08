import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Command } from 'commander';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerTasksCommand } from '../../src/cli/commands/tasks.js';
import { handleTasksReadiness } from '../../src/server/routes/tasks.js';
import { drawingFileCheck } from '../../src/lib/handoff-readiness.js';
import { makePlanVault, makeReadyTask, type PlanVault } from '../helpers/plan-vault.js';

/**
 * The owner-approval gate on both doors into Develop (owner 2026-11-08): `tasks ready` and the
 * Develop button's `GET /tasks/:slug/readiness` refuse a UI plan with no recorded yes on the
 * outcome and on an existing drawing, and pass a plan that changes no UX/UI.
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

async function readiness(slug: string): Promise<any> {
  let body: any = null;
  const res = { writeHead() {}, end(d: string) { body = JSON.parse(d); }, setHeader() {} } as unknown as ServerResponse;
  await handleTasksReadiness({ method: 'GET', headers: {} } as unknown as IncomingMessage, res, { slug }, v.root);
  return body;
}

const tech = (slug: string, text: string) => v.backend.insertSection(slug, 'Technical Details', text, { position: 'bottom' });

describe('owner-approval gate on both Develop doors', () => {
  it('a plan that changes no UX/UI stays ready', async () => {
    const slug = await makeReadyTask(v, 'Backend only');
    expect((await tasksReady(slug)).code).toBe(0);
    expect((await readiness(slug)).ready).toBe(true);
  });

  it('a UI plan is refused until the outcome and an existing drawing are recorded', async () => {
    const slug = await makeReadyTask(v, 'Runs page chips');
    await tech(slug, '- dashboard/src/pages/Runs.tsx: chip row');
    let r = await tasksReady(slug);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/no owner-approved outcome/);
    expect(r.text).toMatch(/no approved drawing/);
    expect((await readiness(slug)).ready).toBe(false);

    await tech(slug, 'Owner-approved outcome: chip row above the list, pressing a chip filters it');
    await tech(slug, 'Approved drawing: _dream_context/state/assets/runs/draft.html');
    r = await tasksReady(slug);
    expect(r.code).toBe(1);
    expect(r.text).toMatch(/is not a file inside the project/);
    const body = await readiness(slug);
    expect(body.ready).toBe(false);
    expect(body.gaps).toEqual([expect.objectContaining({ field: 'technical_details', problem: expect.stringMatching(/not a file inside the project/) })]);

    mkdirSync(join(v.root, 'state', 'assets', 'runs'), { recursive: true });
    writeFileSync(join(v.root, 'state', 'assets', 'runs', 'draft.html'), '<div>draft, not the final version</div>');
    expect((await tasksReady(slug)).code).toBe(0);
    expect((await readiness(slug)).ready).toBe(true);
  });
});

describe('drawingFileCheck', () => {
  it('accepts a real file in the project; refuses absolute, .., missing, a folder and a symlink', () => {
    const check = drawingFileCheck(v.root);
    mkdirSync(join(v.project, 'docs'), { recursive: true });
    writeFileSync(join(v.project, 'docs', 'ui.html'), '<p>x</p>');
    symlinkSync(join(v.project, 'docs', 'ui.html'), join(v.project, 'docs', 'link.html'));
    expect(check('docs/ui.html')).toBe(true);
    expect(check(join(v.project, 'docs', 'ui.html'))).toBe(false);
    expect(check('../outside.html')).toBe(false);
    expect(check('docs/none.html')).toBe(false);
    expect(check('docs')).toBe(false);
    expect(check('docs/link.html')).toBe(false);
  });
});
