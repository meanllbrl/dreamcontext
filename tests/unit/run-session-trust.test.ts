/**
 * Which session a run lives in, as a surface may believe it (AI Team W2). The run cache is synced,
 * so a planted id there never opens anything; a note survives the run for as long as its transcript
 * does, so K4 still holds for a killed run; and what a phone reads of a run is an allowlist.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isRunSession, offerableSession, phoneRunItems, runChatSession } from '../../src/lib/automations/run-chat.js';
import { isNotedRunSession, noteRunSession, replaceRunSession, runningSessionFor } from '../../src/lib/automations/run-session.js';
import { recordAutomationSession } from '../../src/lib/automations/session-registry.js';
import { listAgentHistory } from '../../src/lib/agents/history.js';
import { appendThreadEntry } from '../../src/lib/automations/threads.js';
import { createAgent } from '../../src/lib/agents/store.js';
import { parseTranscriptHistory } from '../../src/lib/transcript-history.js';

const A = '6f02f3ed-0e2e-434e-b0b3-b4f606e32879';
const B = '7f02f3ed-0e2e-434e-b0b3-b4f606e32870';
const C = '8f02f3ed-0e2e-434e-b0b3-b4f606e32871';
const RUN = '2026-10-30T09:00:00.000Z';
const OLD = 5 * 86_400_000;

let home: string;
let root: string;

const transcript = (id: string): string => {
  const dir = join(home, '.claude', 'projects', '-scratch');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.jsonl`);
  writeFileSync(p, '{}\n');
  return p;
};
const plantCache = (slug: string, sessionId: string): void => {
  mkdirSync(join(root, 'automations', 'cache'), { recursive: true });
  writeFileSync(join(root, 'automations', 'cache', `${slug}.json`), JSON.stringify({ history: [{ firedAt: RUN, sessionId, status: 'ok' }] }));
};

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'run-trust-home-')));
  root = join(realpathSync(mkdtempSync(join(tmpdir(), 'run-trust-'))), '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
});

describe('a note lives at the home boundary, first write wins', () => {
  it('is written under ~/.dreamcontext, never in the brain', () => {
    noteRunSession(root, 'watcher', RUN, A, Date.now(), home);
    expect(runningSessionFor(root, 'watcher', RUN, home)).toBe(A);
    expect(existsSync(join(root, 'state', '.run-sessions'))).toBe(false);
    expect(readdirSync(join(home, '.dreamcontext', 'run-sessions')).length).toBeGreaterThan(0);
  });

  it('keys on the project: the same slug and run in another project reads nothing', () => {
    noteRunSession(root, 'watcher', RUN, A, Date.now(), home);
    const other = join(realpathSync(mkdtempSync(join(tmpdir(), 'run-other-'))), '_dream_context');
    expect(runningSessionFor(other, 'watcher', RUN, home)).toBeNull();
  });

  it('a nested claude cannot point the run at itself, and is marked a run all the same', () => {
    noteRunSession(root, 'watcher', RUN, A, Date.now(), home);
    noteRunSession(root, 'watcher', RUN, B, Date.now(), home);
    expect(runningSessionFor(root, 'watcher', RUN, home)).toBe(A);
    expect(isNotedRunSession(A, home)).toBe(true);
    expect(isNotedRunSession(B, home)).toBe(true);
    expect(isRunSession(root, [B], home)).toBe(true);
  });

  it('the binding at exit replaces the note, and the first session stays marked', () => {
    noteRunSession(root, 'watcher', RUN, A, Date.now(), home);
    replaceRunSession(root, 'watcher', RUN, B, home);
    expect(runningSessionFor(root, 'watcher', RUN, home)).toBe(B);
    expect(isNotedRunSession(A, home)).toBe(true);
    expect(isNotedRunSession(B, home)).toBe(true);
  });

  it('a malformed id writes nothing', () => {
    noteRunSession(root, 'watcher', RUN, '../../evil', Date.now(), home);
    expect(runningSessionFor(root, 'watcher', RUN, home)).toBeNull();
  });
});

describe('the sweep keeps a killed run a run while its transcript exists', () => {
  const folder = (): string => join(home, '.dreamcontext', 'run-sessions');
  const age = (now: number): void => {
    for (const n of readdirSync(folder())) utimesSync(join(folder(), n), new Date(now - OLD), new Date(now - OLD));
  };

  it('an old note with a transcript stays; one with none goes', () => {
    const now = Date.now();
    transcript(A);
    noteRunSession(root, 'watcher', RUN, A, now, home);
    noteRunSession(root, 'other', RUN, B, now, home);
    age(now);
    noteRunSession(root, 'third', RUN, C, now, home);
    expect(isNotedRunSession(A, home)).toBe(true);
    expect(runningSessionFor(root, 'watcher', RUN, home)).toBe(A);
    expect(isNotedRunSession(B, home)).toBe(false);
    expect(runningSessionFor(root, 'other', RUN, home)).toBeNull();
  });

  it('runs at most once per window: a hook does not walk the folder every time', () => {
    const now = Date.now();
    noteRunSession(root, 'watcher', RUN, A, now, home);
    const swept = statSync(join(folder(), '.swept')).mtimeMs;
    noteRunSession(root, 'other', RUN, B, now + 1000, home);
    expect(statSync(join(folder(), '.swept')).mtimeMs).toBe(swept);
  });
});

describe('runChatSession trusts this machine, never the synced cache', () => {
  it('a planted cache id opens nothing, though its transcript is on disk', () => {
    transcript(A);
    plantCache('watcher', A);
    expect(runChatSession(root, 'watcher', RUN, home)).toBeNull();
    expect(offerableSession('watcher', A, home)).toBeNull();
  });

  it('a binding to ANOTHER slug does not lend itself', () => {
    transcript(A);
    recordAutomationSession('other', A, home, Date.now(), undefined, RUN);
    plantCache('watcher', A);
    expect(runChatSession(root, 'watcher', RUN, home)).toBeNull();
    expect(offerableSession('watcher', A, home)).toBeNull();
  });

  it('a bound run with a transcript resumes; with none it opens nothing', () => {
    recordAutomationSession('watcher', A, home, Date.now(), undefined, RUN);
    expect(runChatSession(root, 'watcher', RUN, home)).toBeNull();
    transcript(A);
    expect(runChatSession(root, 'watcher', RUN, home)).toEqual({ claudeId: A, resumable: true });
    expect(offerableSession('watcher', A, home)).toBe(A);
  });

  it('a running or killed run is shown from its note and cannot be continued', () => {
    noteRunSession(root, 'watcher', RUN, A, Date.now(), home);
    expect(runChatSession(root, 'watcher', RUN, home)).toBeNull();
    transcript(A);
    expect(runChatSession(root, 'watcher', RUN, home)).toEqual({ claudeId: A, resumable: false });
  });

  it('the history carries it for the owner and never for the agent', () => {
    createAgent(root, { slug: 'watcher', title: 'Watcher', prompt: 'watcher minds the fictional Acme line.', learning: false }, { approve: { now: new Date(RUN), home } });
    appendThreadEntry(root, 'watcher', { runId: RUN, kind: 'system', event: 'started', text: 'Run started.', via: 'runner' });
    appendThreadEntry(root, 'watcher', { runId: RUN, kind: 'system', event: 'ok', text: 'Finished.', via: 'runner', result: 'Acme is healthy.' });
    transcript(A);
    plantCache('watcher', A);
    const owner = () => listAgentHistory(root, 'watcher', { audience: 'owner', home }).sessions[0];
    expect(owner().claudeId).toBeUndefined();
    expect(owner().resumable).toBeUndefined();
    recordAutomationSession('watcher', A, home, Date.now(), undefined, RUN);
    expect(owner()).toMatchObject({ claudeId: A, resumable: true });
    const agent = listAgentHistory(root, 'watcher', { audience: 'agent', home }).sessions[0];
    expect(agent?.claudeId).toBeUndefined();
  });
});

describe('isRunSession: the phone rule knows a run however it ended', () => {
  it('a live or killed run (noted), a finished one (bound), a retired one (the cache)', () => {
    expect(isRunSession(root, [A], home)).toBe(false);
    noteRunSession(root, 'watcher', RUN, A, Date.now(), home);
    expect(isRunSession(root, [A], home)).toBe(true);
    recordAutomationSession('watcher', B, home, Date.now(), undefined, RUN);
    expect(isRunSession(null, [B], home)).toBe(true);
    plantCache('old', C);
    expect(isRunSession(root, [C], home)).toBe(true);
    expect(isRunSession(null, [C], home)).toBe(false);
  });

  it('an uppercased id is the same run: a transcript opens under either case', () => {
    noteRunSession(root, 'watcher', RUN, A, Date.now(), home);
    recordAutomationSession('watcher', B, home, Date.now(), undefined, RUN);
    plantCache('old', C);
    for (const id of [A, B, C]) expect(isRunSession(root, [id.toUpperCase()], home)).toBe(true);
  });
});

describe('phoneRunItems is an allowlist (K4)', () => {
  const TOKEN = 'FIXTURE-TOKEN-5f3a';
  const raw = [
    { type: 'user', uuid: 'u', message: { role: 'user', content: `composed prompt ${TOKEN}` } },
    { type: 'assistant', uuid: 'a', message: { role: 'assistant', content: [
      { type: 'thinking', thinking: `thinking about ${TOKEN}` },
      { type: 'text', text: 'Acme is healthy.' },
      { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: `curl -H "Authorization: ${TOKEN}" https://acme.example` } },
    ] } },
    { type: 'user', uuid: 'r', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `output ${TOKEN}` }] } },
  ].map((r) => JSON.stringify(r)).join('\n');

  it('keeps the words and the bare tool name, nothing a tool was given or returned', () => {
    const before = parseTranscriptHistory(raw);
    expect(JSON.stringify(before)).toContain(TOKEN);
    const out = phoneRunItems(before);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.map((i) => i.kind)).toEqual(['text', 'tool']);
    expect(out[0].text).toBe('Acme is healthy.');
    expect(out[1]).toEqual({ kind: 'tool', toolUseId: 'toolu_1', name: 'Bash', status: 'done' });
  });

  it('a field added to an item later does not cross', () => {
    const out = phoneRunItems([{ kind: 'tool', toolUseId: 't', name: 'Read', aNewField: 'NEW-MARKER' } as never, { kind: 'text', text: 'w', another: 'NEW-MARKER' } as never]);
    expect(JSON.stringify(out)).not.toContain('NEW-MARKER');
  });

  it('a tool with no id is dropped, the pane would drop it too', () => {
    expect(phoneRunItems([{ kind: 'tool', name: 'Bash' }])).toEqual([]);
  });
});
