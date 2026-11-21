import { describe, expect, it } from 'vitest';
import { parseJob } from '../../src/lib/super/jobs.js';

/**
 * `super delegate --fast|--full` / `pool add` (D3, AC1): the lane a job asks for rides the job
 * body only with a worktree, as exactly `fast` or `full`; anything else is refused at parse time,
 * so no route writes a lane intent nobody asked for. Writing the intent file itself is
 * lane-intent.test.ts; the gate that decides fast from the diff is run-lane-fast.test.ts.
 */
describe('parseJob: the lane a job asks for', () => {
  it('fast or full with a worktree rides the job', () => {
    expect(parseJob({ prompt: 'p', worktree: 'dreamcontext', laneIntent: 'fast' })).toMatchObject({ job: { laneIntent: 'fast', worktree: 'dreamcontext' } });
    expect(parseJob({ prompt: 'p', worktree: 'dreamcontext', laneIntent: 'full' })).toMatchObject({ job: { laneIntent: 'full' } });
  });

  it('no lane asked: none on the job (the diff decides, never fast by default)', () => {
    const r = parseJob({ prompt: 'p', worktree: 'dreamcontext' });
    expect('job' in r && r.job.laneIntent).toBeFalsy();
  });

  it('a lane without a worktree, or a lane that is neither, is refused', () => {
    expect(parseJob({ prompt: 'p', laneIntent: 'fast' })).toEqual({ error: expect.stringMatching(/need --worktree/) });
    expect(parseJob({ prompt: 'p', worktree: 'dreamcontext', laneIntent: 'light' })).toEqual({ error: 'laneIntent must be fast or full' });
  });
});
