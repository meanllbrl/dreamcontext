/**
 * Runs that need a human, and the machine-local watermark that stops them
 * arriving twice (D7 / D-I).
 *
 * The property under test is narrow and load-bearing: this is the ONLY thing
 * that turns "an automation stopped and asked at 06:30 while nobody was here"
 * into a surface a human will actually see. Two directions of failure matter
 * and they pull opposite ways — surfacing a run twice is an annoyance, and
 * failing to surface one at all is the whole bug this exists to fix, so every
 * degrade path below resolves toward "show it again" rather than "swallow it".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ackAttention,
  attentionRuns,
  attentionWatermark,
  attentionWatermarkPath,
} from '../../src/lib/automations/attention.js';
import { createAutomation, recordRun } from '../../src/lib/automations/store.js';
import { createQuestion } from '../../src/lib/automations/hitl.js';
import { recordAutomationSession } from '../../src/lib/automations/session-registry.js';
import { findTranscriptBySessionId } from '../../src/lib/transcript-locate.js';
import type { RunEvent } from '../../src/lib/automations/types.js';

let root: string;
let contextRoot: string;
let home: string;

const PROJECT = '/Users/test/proj';
const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-08-28T12:00:00.000Z');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-attention-'));
  contextRoot = join(root, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
  home = mkdtempSync(join(tmpdir(), 'dc-attention-home-'));
  createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD Digest', days: 'daily', at: '18:00' });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** A transcript on disk for `id`, where `findTranscriptBySessionId` looks. A
 *  uuid with no transcript is deliberately not offered (`--resume` would
 *  fresh-pin a blank chat claiming to be the run), so every fixture that
 *  expects to be surfaced must have one. */
/** Bind `id` to `slug` machine-locally, the way the runner does for every
 *  parsed run, and put its transcript where the locator looks. Both are now
 *  required before a run is offered. */
function seedRun(slug: string, id: string): void {
  recordAutomationSession(slug, id, home);
  seedTranscript(id);
}

function seedTranscript(id: string): void {
  const dir = join(home, '.claude', 'projects', 'dc-attention-proj');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), `{"sessionId":"${id}","type":"user"}\n`, 'utf-8');
}

function runEvent(o: Partial<RunEvent> = {}): RunEvent {
  return {
    firedAt: '2026-08-28T06:30:00.000Z',
    startedAt: '2026-08-28T06:30:01.000Z',
    finishedAt: '2026-08-28T06:31:00.000Z',
    status: 'ok',
    durationMs: 59000,
    outputPath: '/out.md',
    error: null,
    exitCode: 0,
    sessionId: SESSION,
    costUsd: 0.02,
    numTurns: 4,
    permissionDenials: 0,
    ...o,
  };
}

describe('attentionRuns — which runs want a human', () => {
  it('surfaces an open flow-hitl question, carrying the ASKING session', () => {
    createQuestion(contextRoot, {
      slug: 'eod-digest',
      runFiredAt: '2026-08-26T06:30:00.000Z',
      kind: 'flow-hitl',
      sessionId: SESSION,
      channel: 'chat',
      question: 'Publish the digest?',
      choices: [],
      nowISO: '2026-08-26T06:54:00.000Z',
    });
    recordAutomationSession('eod-digest', SESSION, home);
    seedTranscript(SESSION);
    const runs = attentionRuns(contextRoot, null, { home });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      slug: 'eod-digest',
      automationTitle: 'EOD Digest',
      reason: 'question',
      sessionId: SESSION,
      status: 'awaiting-review',
      at: '2026-08-26T06:54:00.000Z',
    });
  });

  it("reaches the asking run even when the gate's own repeats buried it in history", () => {
    // The exact production state: the review gate refuses on every tick and
    // records a session-less row each time, so the asking run is nowhere in
    // `cache.history` any more. The question record is the only survivor.
    createQuestion(contextRoot, {
      slug: 'eod-digest',
      runFiredAt: '2026-08-26T06:30:00.000Z',
      kind: 'flow-hitl',
      sessionId: SESSION,
      channel: 'chat',
      question: 'Publish the digest?',
      choices: [],
      nowISO: '2026-08-26T06:54:00.000Z',
    });
    for (let i = 0; i < 60; i++) {
      recordRun(contextRoot, 'eod-digest', runEvent({
        status: 'awaiting-review', sessionId: null, firedAt: `2026-08-2${i % 8}T06:30:00.000Z`,
      }), { advanceWatermark: false });
    }
    recordAutomationSession('eod-digest', SESSION, home);
    seedTranscript(SESSION);
    const runs = attentionRuns(contextRoot, null, { home });
    expect(runs.filter((r) => r.reason === 'question')).toHaveLength(1);
    expect(runs[0].sessionId).toBe(SESSION);
  });

  it('SKIPS a question whose session this machine never bound — a synced question is not a capability', () => {
    // The leak: `automations/hitl/<slug>/<id>.json` lives inside the brain and is
    // kept out of git only by a .gitignore line the runner re-ensures
    // best-effort. A teammate whose ignore missed the window publishes a live,
    // resumable bypassPermissions uuid to everyone who pulls — and the WS resume
    // gate does not cover this source (it scans automations/cache/*.json only).
    // Auto-open would be the first thing to turn that file into an unattended
    // `--resume`, so the binding is checked before the uuid is ever surfaced.
    createQuestion(contextRoot, {
      slug: 'eod-digest',
      runFiredAt: '2026-08-26T06:30:00.000Z',
      kind: 'flow-hitl',
      sessionId: SESSION,
      channel: 'chat',
      question: 'Publish the digest?',
      choices: [],
      nowISO: '2026-08-26T06:54:00.000Z',
    });
    // NOT bound on this machine — nothing here ever ran it.
    expect(attentionRuns(contextRoot, null, { home })).toEqual([]);
    // Bound under SOME automation ⇒ it is a real local capability and surfaces.
    recordAutomationSession('eod-digest', SESSION, home);
    seedTranscript(SESSION);
    expect(attentionRuns(contextRoot, null, { home })).toHaveLength(1);
  });

  it('SKIPS a session bound to a DIFFERENT automation — binding must mean bound to THIS one', () => {
    // The confused deputy. A uuid belonging to a real, already-approved
    // automation is also visible in that automation's brain-synced cache, so
    // anyone who can write the shared brain could plant a second automation
    // whose question claims the same uuid with their own text. A slug-agnostic
    // binding check passes it — the uuid genuinely IS bound, just to something
    // else — and the human then answers what they believe is the planted
    // automation's question straight into the real one's live session.
    createAutomation(contextRoot, { slug: 'impostor', title: 'Impostor', days: 'daily', at: '04:00' });
    recordAutomationSession('eod-digest', SESSION, home); // bound to the REAL one
    seedTranscript(SESSION);
    createQuestion(contextRoot, {
      slug: 'impostor',
      runFiredAt: '2026-08-26T06:30:00.000Z',
      kind: 'flow-hitl',
      sessionId: SESSION,
      channel: 'chat',
      question: 'Approve the transfer?',
      choices: [],
      nowISO: '2026-08-26T06:54:00.000Z',
    });
    expect(attentionRuns(contextRoot, null, { home })).toEqual([]);
  });

  it('skips an approval question — it has no session to resume, by construction', () => {
    createQuestion(contextRoot, {
      slug: 'eod-digest',
      runFiredAt: '2026-08-26T06:30:00.000Z',
      kind: 'approval',
      sessionId: SESSION, // hitl.ts forces this to null for 'approval'
      channel: 'chat',
      question: 'The manifest changed. Trust it?',
      choices: [],
      nowISO: '2026-08-26T06:54:00.000Z',
    });
    recordAutomationSession('eod-digest', SESSION, home);
    seedTranscript(SESSION);
    expect(attentionRuns(contextRoot, null, { home })).toEqual([]);
  });

  it('surfaces failed and timed-out runs, and NOT clean ones', () => {
    recordRun(contextRoot, 'eod-digest', runEvent({ status: 'ok', sessionId: SESSION }));
    recordRun(contextRoot, 'eod-digest', runEvent({
      status: 'failed', sessionId: OTHER_SESSION, error: 'boom', finishedAt: '2026-08-28T07:00:00.000Z',
    }));
    seedRun('eod-digest', SESSION);
    seedRun('eod-digest', OTHER_SESSION);
    const runs = attentionRuns(contextRoot, null, { home });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ reason: 'failed', sessionId: OTHER_SESSION, error: 'boom' });
  });

  it('never returns a run with no session — there is nothing to resume, and --resume would fresh-pin a lie', () => {
    recordRun(contextRoot, 'eod-digest', runEvent({ status: 'failed', sessionId: null }));
    expect(attentionRuns(contextRoot, null, { home })).toEqual([]);
  });

  it('never returns a run whose transcript is gone — --resume would fresh-pin a BLANK chat claiming to be it', () => {
    // The transcript's lifetime is owned by nothing here: Claude Code prunes it,
    // so does any disk cleanup, and this feature is built to tolerate a question
    // sitting for days. `--resume` against a missing one does not error; the
    // chat route fresh-pins an empty conversation under the same uuid.
    recordRun(contextRoot, 'eod-digest', runEvent({
      status: 'failed', sessionId: OTHER_SESSION, finishedAt: '2026-08-28T07:00:00.000Z',
    }));
    recordAutomationSession('eod-digest', OTHER_SESSION, home);
    expect(attentionRuns(contextRoot, null, { home })).toEqual([]);
    seedTranscript(OTHER_SESSION);
    expect(attentionRuns(contextRoot, null, { home })).toHaveLength(1);
  });

  it('filters on when it became worth surfacing, and returns oldest first', () => {
    createAutomation(contextRoot, { slug: 'other-job', title: 'Other Job', days: 'daily', at: '19:00' });
    recordRun(contextRoot, 'eod-digest', runEvent({
      status: 'failed', sessionId: SESSION, finishedAt: '2026-08-28T05:00:00.000Z',
    }));
    recordRun(contextRoot, 'other-job', runEvent({
      status: 'failed', sessionId: OTHER_SESSION, finishedAt: '2026-08-28T09:00:00.000Z',
    }));
    seedRun('eod-digest', SESSION);
    seedRun('other-job', OTHER_SESSION);
    expect(attentionRuns(contextRoot, null, { home }).map((r) => r.sessionId)).toEqual([SESSION, OTHER_SESSION]);
    expect(attentionRuns(contextRoot, '2026-08-28T06:00:00.000Z', { home }).map((r) => r.sessionId)).toEqual([OTHER_SESSION]);
    expect(attentionRuns(contextRoot, '2026-08-28T10:00:00.000Z', { home })).toEqual([]);
  });

  it('compares the FINISH time, not the schedule — a catch-up run must not be dropped', () => {
    // Fired two days ago, ran just now. Comparing `firedAt` against a watermark
    // that tracks when things were SHOWN would silently swallow it.
    recordRun(contextRoot, 'eod-digest', runEvent({
      status: 'failed',
      sessionId: SESSION,
      firedAt: '2026-08-26T06:30:00.000Z',
      finishedAt: '2026-08-28T11:00:00.000Z',
    }));
    seedRun('eod-digest', SESSION);
    expect(attentionRuns(contextRoot, '2026-08-27T00:00:00.000Z', { home }).map((r) => r.sessionId))
      .toEqual([SESSION]);
  });

  it('shows ONE failure per automation — a noisy job cannot bury a quiet one', () => {
    // THE BUG THIS PINS. The cap used to be a flat "newest 8" over every
    // automation's failures. A job whose manifest broke fails on every tick, so
    // its twenty repeats filled the window and pushed a DIFFERENT automation's
    // single failure out of it — and because the client acks the newest run it
    // received, the watermark then advanced PAST the one it never saw, losing it
    // permanently rather than deferring it. One per slug makes that unreachable.
    createAutomation(contextRoot, { slug: 'noisy', title: 'Noisy', days: 'daily', at: '01:00' });
    createAutomation(contextRoot, { slug: 'quiet', title: 'Quiet', days: 'daily', at: '02:00' });
    for (let i = 0; i < 20; i++) {
      const id = `3333333${i % 10}-3333-4333-8333-33333333333${i % 10}`;
      recordRun(contextRoot, 'noisy', runEvent({
        status: 'failed',
        sessionId: id,
        finishedAt: `2026-08-28T${String(4 + (i % 20)).padStart(2, '0')}:00:00.000Z`,
      }), { advanceWatermark: false });
      seedRun('noisy', id);
    }
    // The quiet one failed FIRST, so a flat newest-N cap would drop it.
    recordRun(contextRoot, 'quiet', runEvent({
      status: 'failed', sessionId: SESSION, finishedAt: '2026-08-28T01:00:00.000Z',
    }));
    seedRun('quiet', SESSION);

    const runs = attentionRuns(contextRoot, null, { home });
    expect(runs.filter((r) => r.slug === 'noisy')).toHaveLength(1);
    expect(runs.map((r) => r.slug)).toContain('quiet');
    // And the one kept for the noisy job is its NEWEST — history is newest-first.
    const noisy = runs.find((r) => r.slug === 'noisy')!;
    expect(noisy.at).toBe('2026-08-28T23:00:00.000Z');
  });

  it('the ceiling keeps the OLDEST, so the ack can never step over a run nobody saw', () => {
    // THE RESIDUAL THIS PINS. The client acks the newest run it opened and the
    // watermark is monotonic, so anything the cap withheld that was OLDER than
    // something transmitted would be stepped over and never offered again.
    // Keeping the tail did exactly that once nine distinct automations needed
    // attention in one unseen window. Keeping the head makes the cap a PACE:
    // this look takes the oldest 8, the next poll picks up where it stopped.
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) {
      const slug = `job-${String(i).padStart(2, '0')}`;
      const id = `4444444${i % 10}-4444-4444-8444-4444444444${String(i).padStart(2, '0')}`;
      ids.push(id);
      createAutomation(contextRoot, { slug, title: slug, days: 'daily', at: '03:00' });
      recordRun(contextRoot, slug, runEvent({
        status: 'failed', sessionId: id, finishedAt: `2026-08-28T${String(i).padStart(2, '0')}:00:00.000Z`,
      }));
      seedRun(slug, id);
    }

    const first = attentionRuns(contextRoot, null, { home });
    expect(first).toHaveLength(8);
    // The OLDEST eight, in order — not the newest eight.
    expect(first.map((r) => r.sessionId)).toEqual(ids.slice(0, 8));

    // Acking what was actually opened advances to the newest of THAT batch, so
    // the next look resumes at the 9th rather than skipping to the end.
    ackAttention(PROJECT, first[first.length - 1].at, home, NOW);
    const second = attentionRuns(contextRoot, attentionWatermark(PROJECT, home), { home });
    expect(second.map((r) => r.sessionId)).toEqual(ids.slice(8));
  });
});

describe('the watermark — machine-local, monotonic, and never consumed by a read', () => {
  it('a read does not advance it', () => {
    recordRun(contextRoot, 'eod-digest', runEvent({ status: 'failed', sessionId: SESSION }));
    seedRun('eod-digest', SESSION);
    attentionRuns(contextRoot, attentionWatermark(PROJECT, home), { home });
    attentionRuns(contextRoot, attentionWatermark(PROJECT, home), { home });
    expect(attentionWatermark(PROJECT, home)).toBeNull();
  });

  it('ack advances it, and a later read returns nothing', () => {
    recordRun(contextRoot, 'eod-digest', runEvent({
      status: 'failed', sessionId: SESSION, finishedAt: '2026-08-28T07:00:00.000Z',
    }));
    seedRun('eod-digest', SESSION);
    expect(attentionRuns(contextRoot, attentionWatermark(PROJECT, home), { home })).toHaveLength(1);
    ackAttention(PROJECT, '2026-08-28T07:00:00.000Z', home, NOW);
    expect(attentionRuns(contextRoot, attentionWatermark(PROJECT, home), { home })).toEqual([]);
  });

  it('is monotonic — an out-of-order ack from a second window cannot rewind it', () => {
    ackAttention(PROJECT, '2026-08-28T09:00:00.000Z', home, NOW);
    ackAttention(PROJECT, '2026-08-28T07:00:00.000Z', home, NOW);
    expect(attentionWatermark(PROJECT, home)).toBe('2026-08-28T09:00:00.000Z');
  });

  it('ignores an unparseable mark rather than writing garbage', () => {
    ackAttention(PROJECT, 'not-a-date', home, NOW);
    expect(attentionWatermark(PROJECT, home)).toBeNull();
  });

  it('is per project — one project acking never silences another', () => {
    ackAttention(PROJECT, '2026-08-28T09:00:00.000Z', home, NOW);
    expect(attentionWatermark('/Users/test/other', home)).toBeNull();
  });

  it('is machine-local at ~/.dreamcontext/automations-tabs.json, mode 0600, no leftover temp', () => {
    ackAttention(PROJECT, '2026-08-28T09:00:00.000Z', home, NOW);
    const path = attentionWatermarkPath(home);
    expect(path).toBe(join(home, '.dreamcontext', 'automations-tabs.json'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => statSync(`${path}.tmp`)).toThrow();
  });

  it('degrades a corrupt file to "nothing shown" — never to "everything shown"', () => {
    const path = attentionWatermarkPath(home);
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(path, '{not json', 'utf-8');
    expect(attentionWatermark(PROJECT, home)).toBeNull();
    recordRun(contextRoot, 'eod-digest', runEvent({ status: 'failed', sessionId: SESSION }));
    seedRun('eod-digest', SESSION);
    // The safe direction: the run is offered again rather than swallowed.
    expect(attentionRuns(contextRoot, attentionWatermark(PROJECT, home), { home })).toHaveLength(1);
  });

  it('never writes into the brain', () => {
    ackAttention(PROJECT, '2026-08-28T09:00:00.000Z', home, NOW);
    const onDisk = readFileSync(attentionWatermarkPath(home), 'utf-8');
    expect(onDisk).toContain(PROJECT);
    expect(() => statSync(join(contextRoot, 'automations', 'automations-tabs.json'))).toThrow();
  });
});
