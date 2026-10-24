/**
 * ONE limit for a task slug (field 2026-10-21: `super delegate --task` refused valid task names
 * past 100 characters; one of them was this very task, 115 characters).
 *
 * `tasks create` writes `state/<slugify(name)>.md` and caps nothing, so the limit is the file
 * system's: 255 bytes a name, 252 for the slug. `src/lib/task-slug.ts` owns that number; every
 * place that validates a task slug takes the whole range, and the dashboard (its own bundle,
 * which cannot import it) carries copies this file pins.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { slugify } from '../../src/lib/id.js';
import { FILE_NAME_MAX, MAX_TASK_SLUG_LENGTH, TASK_SLUG_RE } from '../../src/lib/task-slug.js';
import * as superTypes from '../../src/lib/super/types.js';
import { parseJob } from '../../src/lib/super/jobs.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { refForState } from '../../src/server/routes/super.js';
import { isValidRef, isValidWidgetRef } from '../../src/lib/whiteboards/validate.js';
import { isValidWidgetRef as dashboardWidgetRef } from '../../dashboard/src/components/whiteboard/widgetModel.js';
import { targetPath } from '../../dashboard/src/components/whiteboard/pagePopupModel.js';
import { MAX_SLUG_CHARS } from '../../dashboard/src/lib/chatViewSpec.js';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const slugOf = (n: number): string => 'a'.repeat(n);

describe('the limit', () => {
  it('is what the file system gives `<slug>.md`', () => {
    expect(FILE_NAME_MAX).toBe(255);
    expect(MAX_TASK_SLUG_LENGTH).toBe(252);
    // The real file system, not only arithmetic: 252 is a task file, 253 is not.
    const dir = mkdtempSync(join(tmpdir(), 'super-end-'));
    try {
      writeFileSync(join(dir, `${slugOf(MAX_TASK_SLUG_LENGTH)}.md`), 'x');
      expect(statSync(join(dir, `${slugOf(MAX_TASK_SLUG_LENGTH)}.md`)).isFile()).toBe(true);
      expect(() => writeFileSync(join(dir, `${slugOf(MAX_TASK_SLUG_LENGTH + 1)}.md`), 'x')).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the chat gates derive the same number', () => {
    expect(MAX_SLUG_CHARS).toBe(MAX_TASK_SLUG_LENGTH);
  });

  it('TASK_SLUG_RE takes every length up to it, and nothing longer', () => {
    for (const n of [1, 63, 99, 100, 115, 200, MAX_TASK_SLUG_LENGTH]) expect(TASK_SLUG_RE.test(slugOf(n)), String(n)).toBe(true);
    expect(TASK_SLUG_RE.test(slugOf(MAX_TASK_SLUG_LENGTH + 1))).toBe(false);
    for (const bad of ['', '-a', 'A', 'a b', 'a/b', '../a']) expect(TASK_SLUG_RE.test(bad), bad).toBe(false);
  });

  it('the Super record uses that one regex', () => {
    expect(superTypes.TASK_SLUG_RE).toBe(TASK_SLUG_RE);
  });

  it('takes the name of THIS task, which `tasks create` made (115 characters)', () => {
    const slug = slugify("Bir işin tek sahibi olur: devreden çocuk kapanır, kartı halefe geçer; meşgul çocuğa gönderilen mesaj hemen yönlendirir");
    expect(slug.length).toBeGreaterThan(100);
    expect(TASK_SLUG_RE.test(slug)).toBe(true);
  });
});

describe('every place that validates a task slug takes the whole range', () => {
  const long = slugOf(MAX_TASK_SLUG_LENGTH);
  const tooLong = slugOf(MAX_TASK_SLUG_LENGTH + 1);

  it('super delegate --task / pool add --task (parseJob)', () => {
    expect(parseJob({ prompt: 'p', task: long })).toMatchObject({ job: { task: long } });
    expect(parseJob({ prompt: 'p', task: tooLong })).toHaveProperty('error');
    // The old limit, which refused valid names:
    expect(parseJob({ prompt: 'p', task: slugOf(115) })).toHaveProperty('job');
  });

  it('a `task` card on the Super stage', () => {
    const state = emptySuperState();
    expect(refForState(state, 'task', long)).toEqual({ ref: long });
    expect(refForState(state, 'task', slugOf(115))).toEqual({ ref: slugOf(115) });
    expect(refForState(state, 'task', tooLong)).toHaveProperty('error');
  });

  it('a task widget on a whiteboard, server and dashboard', () => {
    for (const fn of [isValidRef, isValidWidgetRef.bind(null, 'task'), dashboardWidgetRef]) {
      expect(fn(long)).toBe(true);
      expect(fn(tooLong)).toBe(false);
    }
  });

  it('the task page popup (dashboard)', () => {
    expect(targetPath({ kind: 'task', ref: long })).toBe(`_dream_context/state/${long}.md`);
    expect(targetPath({ kind: 'task', ref: tooLong })).toBeNull();
  });

  it('DRIFT: no other file defines its own TASK_SLUG_RE', () => {
    const owners: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'dist') continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /\bTASK_SLUG_RE\s*=/.test(readFileSync(p, 'utf-8'))) owners.push(p.slice(ROOT.length).replace(/\\/g, '/'));
      }
    };
    walk(join(ROOT, 'src'));
    walk(join(ROOT, 'dashboard/src'));
    // The one source, and the dashboard's pinned copy (above).
    expect(owners.sort()).toEqual(['dashboard/src/components/whiteboard/pagePopupModel.ts', 'src/lib/task-slug.ts']);
  });
});
