/**
 * Session state merge at Return (Transport 2, "Session state merge"; AC5, AC8).
 *
 * `.agent-sessions.json`, `.session-titles.json` and `.agent-session-map/` are taken OUT of
 * the generic non-git three-way and merged PER ENTRY BY ID against the trip-start copy:
 *  - roster: per tab (by conversation id) the cloud wins; a tab present at trip start and
 *    absent in the cloud was closed on the phone (tombstone: dropped); a cloud-only tab lands
 *    with `bypass: false`; `bypass` of a tab both sides have and `chatPermissionMode` are
 *    ALWAYS the laptop's (every permission field stays the laptop's). The write goes through
 *    lane F's `writeMergedRosterSurface` (generation bump, so a stale dashboard PUT gets 409);
 *  - titles: per conversation id the cloud's entry wins when it changed since trip start;
 *  - tab→session map: per tab file the cloud's version wins when it changed; never deleted
 *    (D20: Return never deletes a laptop non-git file).
 * Every laptop file the merge overwrites is backed up first (Roll back restores it).
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatPermissionMode, SavedMeta } from '../../server/routes/agent-sessions.js';
import { BackupStore } from './apply.js';
import { backupDir, type OpHandlers } from './journal.js';
import { atomicWriteFile } from './paths.js';

export const ROSTER_REL = '_dream_context/state/.agent-sessions.json';
export const TITLES_REL = '_dream_context/state/.session-titles.json';
export const SESSION_MAP_REL = '_dream_context/state/.agent-session-map';
const MAP_FILE_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\.json$/;
const MAX_SESSIONS = 20;

/** Paths the generic three-way must leave to this merge. */
export function isSessionStatePath(rel: string): boolean {
  return rel === ROSTER_REL || rel === TITLES_REL || (rel.startsWith(SESSION_MAP_REL + '/') && MAP_FILE_RE.test(rel.slice(SESSION_MAP_REL.length + 1)));
}

export interface RosterSurface {
  sessions: SavedMeta[];
  activePane?: number;
  chatPermissionMode: ChatPermissionMode;
}

/** Lane F's roster surface (`readRosterSurface` / `writeMergedRosterSurface`), injected. */
export interface RosterIO {
  read(contextRoot: string): RosterSurface & { generation: number };
  /**
   * Lane F's `writeMergedRosterSurfaceAsync`: waits (bounded) for the roster lock and throws
   * `RosterBusyError` (`roster_busy`) when it stays held. Returns the new generation.
   */
  write(contextRoot: string, surface: RosterSurface): number | Promise<number>;
}

export interface RosterMergeReport {
  /** Titles of tabs closed on the phone (dropped). */
  closedOnPhone: string[];
  /** Titles of tabs opened on the phone (landed with bypass:false). */
  openedOnPhone: string[];
  /** Tabs whose metadata the cloud changed. */
  updated: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function mergeRoster(start: RosterSurface, laptop: RosterSurface, cloud: RosterSurface): { surface: RosterSurface; report: RosterMergeReport } {
  const report: RosterMergeReport = { closedOnPhone: [], openedOnPhone: [], updated: 0 };
  const startIds = new Set(start.sessions.map((s) => s.sessionId).filter(Boolean));
  const cloudById = new Map(cloud.sessions.filter((s) => s.sessionId).map((s) => [s.sessionId!, s]));
  const used = new Set<string>();
  const out: SavedMeta[] = [];
  for (const l of laptop.sessions) {
    const id = l.sessionId;
    if (!id) { out.push(l); continue; }
    const c = cloudById.get(id);
    if (c) {
      used.add(id);
      // Cloud wins per entry; the permission field stays the laptop's.
      const merged: SavedMeta = { ...c, bypass: l.bypass };
      if (!same(merged, l)) report.updated++;
      out.push(merged);
    } else if (startIds.has(id)) {
      report.closedOnPhone.push(l.title); // tombstone: closed on the phone
    } else {
      out.push(l);
    }
  }
  for (const c of cloud.sessions) {
    if (!c.sessionId || used.has(c.sessionId) || out.some((x) => x.sessionId === c.sessionId)) continue;
    if (startIds.has(c.sessionId)) continue; // closed on the laptop meanwhile: the laptop's close stands
    out.push({ ...c, bypass: false });
    report.openedOnPhone.push(c.title);
  }
  return {
    surface: {
      sessions: out.slice(0, MAX_SESSIONS),
      ...(cloud.activePane !== undefined ? { activePane: cloud.activePane } : laptop.activePane !== undefined ? { activePane: laptop.activePane } : {}),
      chatPermissionMode: laptop.chatPermissionMode,
    },
    report,
  };
}

type TitleStore = Record<string, unknown>;

function titlesOf(raw: unknown): TitleStore {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { titles?: unknown }).titles : undefined;
  return t && typeof t === 'object' && !Array.isArray(t) ? { ...(t as TitleStore) } : {};
}

/** Per conversation id: the cloud's entry wins when it changed since trip start. */
export function mergeTitles(start: unknown, laptop: unknown, cloud: unknown): { store: { titles: TitleStore }; changed: number } {
  const s = titlesOf(start);
  const out = titlesOf(laptop);
  let changed = 0;
  for (const [id, entry] of Object.entries(titlesOf(cloud))) {
    if (same(entry, s[id]) || same(entry, out[id])) continue;
    out[id] = entry;
    changed++;
  }
  return { store: { titles: out }, changed };
}

// ---------------------------------------------------------------- the journal op

export interface SessionMergeParams {
  /** Local root (from the go manifest by root id). */
  root: string;
  scope: string;
  /** Trip-start copies, laid out as `<dir>/_dream_context/state/...`. */
  startDir: string;
  /** The cloud's versions that changed (extracted from the return pack), same layout. */
  cloudDir: string;
}

function readJsonFile(path: string): unknown {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

/** The cloud's copy of `rel` when the return pack carried it, else the trip-start copy (unchanged in the cloud). */
function cloudOrStart(p: SessionMergeParams, rel: string): string {
  const c = join(p.cloudDir, ...rel.split('/'));
  return existsSync(c) ? c : join(p.startDir, ...rel.split('/'));
}

function writeWithBackup(store: BackupStore, root: string, rel: string, data: Buffer): void {
  const abs = join(root, ...rel.split('/'));
  if (existsSync(abs)) store.saveBefore(root, rel, 'overwritten');
  else store.recordCreate(rel, { sha256: createHash('sha256').update(data).digest('hex') });
  atomicWriteFile(abs, data, 0o600);
}

export interface SessionMergeResult {
  roster: RosterMergeReport | null;
  titlesChanged: number;
  mapFilesWritten: number;
}

export function sessionMergeHandlers(o: { tripDir: string; roster: RosterIO }): OpHandlers {
  return {
    'session.merge': {
      apply: async (op) => {
        const p = op.params as SessionMergeParams;
        const store = new BackupStore(backupDir(o.tripDir, p.scope));
        const res: SessionMergeResult = { roster: null, titlesChanged: 0, mapFilesWritten: 0 };
        const laptopCtx = join(p.root, '_dream_context');

        // Roster: only when the cloud's copy came back changed.
        if (existsSync(join(p.cloudDir, ...ROSTER_REL.split('/')))) {
          const cloudCtx = join(p.cloudDir, '_dream_context');
          const startCtx = join(p.startDir, '_dream_context');
          const merged = mergeRoster(o.roster.read(startCtx), o.roster.read(laptopCtx), o.roster.read(cloudCtx));
          const abs = join(p.root, ...ROSTER_REL.split('/'));
          if (existsSync(abs)) store.saveBefore(p.root, ROSTER_REL, 'overwritten');
          else store.recordCreate(ROSTER_REL, { sha256: '0'.repeat(64) });
          mkdirSync(join(laptopCtx, 'state'), { recursive: true });
          // The roster is the FIRST write of this op: a lock that stays held (RosterBusyError)
          // throws here with nothing written, the op stays `started`, and Resume retries it.
          await o.roster.write(laptopCtx, merged.surface);
          if (!lstatSync(abs).isSymbolicLink()) store.refineCreate(ROSTER_REL, { sha256: createHash('sha256').update(readFileSync(abs)).digest('hex') });
          res.roster = merged.report;
        }

        // Titles.
        if (existsSync(join(p.cloudDir, ...TITLES_REL.split('/')))) {
          const m = mergeTitles(
            readJsonFile(join(p.startDir, ...TITLES_REL.split('/'))),
            readJsonFile(join(p.root, ...TITLES_REL.split('/'))),
            readJsonFile(cloudOrStart(p, TITLES_REL)),
          );
          if (m.changed > 0) writeWithBackup(store, p.root, TITLES_REL, Buffer.from(JSON.stringify(m.store, null, 2) + '\n'));
          res.titlesChanged = m.changed;
        }

        // Tab -> session map: per file, the cloud's changed version wins; nothing is deleted.
        const cloudMap = join(p.cloudDir, ...SESSION_MAP_REL.split('/'));
        let names: string[] = [];
        try { names = readdirSync(cloudMap).filter((n) => MAP_FILE_RE.test(n)); } catch { /* none changed */ }
        for (const n of names.sort()) {
          const rel = `${SESSION_MAP_REL}/${n}`;
          const data = readFileSync(join(cloudMap, n));
          let cur: Buffer | null = null;
          try { cur = readFileSync(join(p.root, ...rel.split('/'))); } catch { /* absent */ }
          if (cur && cur.equals(data)) continue;
          mkdirSync(join(p.root, ...SESSION_MAP_REL.split('/')), { recursive: true });
          writeWithBackup(store, p.root, rel, data);
          res.mapFilesWritten++;
        }
        return res;
      },
      undo: async (op) => {
        const p = op.params as SessionMergeParams;
        return new BackupStore(backupDir(o.tripDir, p.scope)).restore(p.root);
      },
    },
  };
}
