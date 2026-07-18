import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveTranscript,
  listSubagentTranscripts,
  subagentIdFromPath,
  SUBAGENT_HARVEST_CAP,
  DIR_LAYOUT_MAIN_CANDIDATES,
} from '../../src/lib/transcript-locate.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'transcript-locate-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

const SID = '4c798797-d409-4a2b-bb17-f44674227c21';

function writeFlat(sessionId: string, dir = projectDir): string {
  const p = join(dir, `${sessionId}.jsonl`);
  writeFileSync(p, '{"type":"human"}\n');
  return p;
}

function makeSessionDir(sessionId: string, dir = projectDir): string {
  const p = join(dir, sessionId);
  mkdirSync(p, { recursive: true });
  return p;
}

describe('resolveTranscript', () => {
  it('resolves the flat layout when only <sessionId>.jsonl exists', () => {
    const flat = writeFlat(SID);
    const loc = resolveTranscript(flat, { sessionId: SID });
    expect(loc).toEqual({ mainPath: flat, sessionDir: null, layout: 'flat' });
  });

  it('prefers flat when both flat and a session dir exist (today\'s real layout)', () => {
    const flat = writeFlat(SID);
    const dir = makeSessionDir(SID);
    mkdirSync(join(dir, 'subagents'), { recursive: true });
    mkdirSync(join(dir, 'tool-results'), { recursive: true });

    const loc = resolveTranscript(flat, { sessionId: SID });
    expect(loc.layout).toBe('flat');
    expect(loc.mainPath).toBe(flat);
    expect(loc.sessionDir).toBe(dir);
  });

  it('degrades to layout "dir" with mainPath null when the dir holds only subagents/ + tool-results/', () => {
    const dir = makeSessionDir(SID);
    mkdirSync(join(dir, 'subagents'), { recursive: true });
    mkdirSync(join(dir, 'tool-results'), { recursive: true });

    const recordedPath = join(projectDir, `${SID}.jsonl`); // never written — verified real-world shape
    const loc = resolveTranscript(recordedPath, { sessionId: SID });
    expect(loc).toEqual({ mainPath: null, sessionDir: dir, layout: 'dir' });
  });

  it('never throws on the dir-only degraded case (graceful fallback, not a silent zero elsewhere)', () => {
    const dir = makeSessionDir(SID);
    mkdirSync(join(dir, 'subagents'), { recursive: true });
    expect(() => resolveTranscript(null, { sessionId: SID, existsImpl: () => true, isDirImpl: () => true }))
      .not.toThrow();
  });

  it('finds a main transcript INSIDE the session dir when present (e.g. a future layout change)', () => {
    const dir = makeSessionDir(SID);
    const inner = join(dir, `${SID}.jsonl`);
    writeFileSync(inner, '{"type":"human"}\n');

    const recordedPath = join(projectDir, `${SID}.jsonl`); // flat file itself absent
    const loc = resolveTranscript(recordedPath, { sessionId: SID });
    expect(loc).toEqual({ mainPath: inner, sessionDir: dir, layout: 'dir' });
  });

  it('resolves to "none" when neither flat file nor session dir exists', () => {
    const recordedPath = join(projectDir, `${SID}.jsonl`);
    const loc = resolveTranscript(recordedPath, { sessionId: SID });
    expect(loc).toEqual({ mainPath: null, sessionDir: null, layout: 'none' });
  });

  it('resolves to "none" when recordedPath is null and no sessionId is given', () => {
    const loc = resolveTranscript(null);
    expect(loc).toEqual({ mainPath: null, sessionDir: null, layout: 'none' });
  });

  it('resolves to "none" when recordedPath is null even with a sessionId (no projectDir to search)', () => {
    const loc = resolveTranscript(null, { sessionId: SID });
    expect(loc).toEqual({ mainPath: null, sessionDir: null, layout: 'none' });
  });

  it('re-derives the flat path when recordedPath is stale but an explicit sessionId resolves the real file', () => {
    const realSid = 'real-session-id';
    const flat = writeFlat(realSid);
    const staleRecordedPath = join(projectDir, 'stale-session-id.jsonl'); // does not exist

    const loc = resolveTranscript(staleRecordedPath, { sessionId: realSid });
    expect(loc.layout).toBe('flat');
    expect(loc.mainPath).toBe(flat);
  });

  it('never throws when existsImpl/isDirImpl themselves throw', () => {
    const boom = () => { throw new Error('boom'); };
    expect(() => resolveTranscript(join(projectDir, `${SID}.jsonl`), {
      sessionId: SID,
      existsImpl: boom,
      isDirImpl: boom,
    })).toThrow(); // caller-injected impls are the caller's contract; defaults never throw
  });

  it('default fs-backed impls never throw on a nonexistent path', () => {
    const loc = resolveTranscript(join(projectDir, 'does-not-exist.jsonl'), { sessionId: 'does-not-exist' });
    expect(loc.layout).toBe('none');
  });

  it('DIR_LAYOUT_MAIN_CANDIDATES probes <sessionId>.jsonl first', () => {
    expect(DIR_LAYOUT_MAIN_CANDIDATES[0]).toBe('<sessionId>.jsonl');
  });
});

describe('listSubagentTranscripts', () => {
  it('returns [] when sessionDir is null', () => {
    expect(listSubagentTranscripts({ mainPath: null, sessionDir: null, layout: 'none' })).toEqual([]);
  });

  it('returns [] when the subagents/ dir is absent', () => {
    const dir = makeSessionDir(SID);
    const loc = { mainPath: null, sessionDir: dir, layout: 'dir' as const };
    expect(listSubagentTranscripts(loc)).toEqual([]);
  });

  it('lists only agent-*.jsonl files, newest mtime first, capped at SUBAGENT_HARVEST_CAP', () => {
    const dir = makeSessionDir(SID);
    const subDir = join(dir, 'subagents');
    mkdirSync(subDir, { recursive: true });

    // Non-matching file must be excluded.
    writeFileSync(join(subDir, 'not-an-agent.txt'), 'noise');

    const total = 25;
    const paths: string[] = [];
    for (let i = 0; i < total; i++) {
      const p = join(subDir, `agent-${String(i).padStart(2, '0')}.jsonl`);
      writeFileSync(p, '{}');
      // Stagger mtimes so ordering is deterministic: higher i = newer.
      const t = new Date(2026, 0, 1, 0, 0, i);
      utimesSync(p, t, t);
      paths.push(p);
    }

    const loc = { mainPath: null, sessionDir: dir, layout: 'dir' as const };
    const result = listSubagentTranscripts(loc);

    expect(result).toHaveLength(SUBAGENT_HARVEST_CAP);
    expect(result).toHaveLength(20);
    // Newest first: agent-24 (i=24) down to agent-05 (i=5), 20 entries.
    expect(result[0]).toBe(paths[24]);
    expect(result[19]).toBe(paths[5]);
    expect(result.every((p) => p.endsWith('.jsonl') && p.includes('agent-'))).toBe(true);
  });

  it('honors an explicit opts.max override', () => {
    const dir = makeSessionDir(SID);
    const subDir = join(dir, 'subagents');
    mkdirSync(subDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(subDir, `agent-${i}.jsonl`), '{}');
    }
    const loc = { mainPath: null, sessionDir: dir, layout: 'dir' as const };
    expect(listSubagentTranscripts(loc, { max: 3 })).toHaveLength(3);
  });

  it('never throws when statImpl throws for one entry (sorts it as oldest)', () => {
    const dir = makeSessionDir(SID);
    const subDir = join(dir, 'subagents');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'agent-a.jsonl'), '{}');
    writeFileSync(join(subDir, 'agent-b.jsonl'), '{}');
    const loc = { mainPath: null, sessionDir: dir, layout: 'dir' as const };
    const statImpl = (p: string) => {
      if (p.endsWith('agent-a.jsonl')) throw new Error('unreadable');
      return { mtimeMs: 1000 };
    };
    expect(() => listSubagentTranscripts(loc, { statImpl })).not.toThrow();
    const result = listSubagentTranscripts(loc, { statImpl });
    expect(result).toHaveLength(2);
  });
});

describe('subagentIdFromPath', () => {
  it('extracts the id from a real agent-*.jsonl path', () => {
    expect(subagentIdFromPath('/a/b/subagents/agent-a80407b614ff89f5e.jsonl')).toBe('a80407b614ff89f5e');
  });

  it('falls back to the basename when the pattern does not match', () => {
    expect(subagentIdFromPath('/a/b/not-an-agent.jsonl')).toBe('not-an-agent.jsonl');
  });
});
