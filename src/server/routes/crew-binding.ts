/**
 * The server side of a Super crew process (uye-bildirim K3 "Identity", "Allow once", "Level").
 *
 * The server spawns every crew process itself (the main Super, a member's Super, their children;
 * the `claude` child and the `dreamcontext t3-chat` bridge child alike), so it is the one party
 * that KNOWS who a process is. At spawn it writes a binding for that pid (grants store), adds the
 * process's conversation id at every `init`, and removes the binding when the process exits:
 * `whoAmI()` in the hook and the bridge reads nothing else. A binding is written only for a
 * process whose start time the OS reports (macOS, premise step 4); elsewhere there is none, and
 * the owner is asked each time.
 *
 * It also keeps the live seats of a member's crew, so a NARROWER autonomy level reaches a running
 * member at once (the measured live mode switch), and remembers which turns the server itself
 * wrote, so his Allow once is never read as his own words.
 *
 * agent-chat.ts calls this in a few lines; the logic lives here (another branch edits that file).
 */
import { realpathSync } from 'node:fs';
import { setChatPermissionMode } from '../../lib/assistant/chat-registry.js';
import { realProcSys, type ProcSys } from '../../lib/grants/binding.js';
import { addConversationId, removeBinding, writeBinding, type StoreOpts } from '../../lib/grants/store.js';
import type { CrewKind } from '../../lib/grants/types.js';
import { narrowerMode } from '../../lib/agents/permission.js';

/** A member mark that names no single member (agent-chat.ts AMBIGUOUS_CREW): never a member binding. */
const AMBIGUOUS = '*';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/i;

/** Modes a running process can be switched INTO live (measured: auto and bypass to default,
 *  bypass to auto). Anything else waits for the next session start. */
const LIVE_TARGETS: ReadonlySet<string> = new Set(['default', 'auto']);

export interface CrewSpawnFacts {
  /** The process the server spawned (undefined when the spawn itself failed). */
  pid: number | undefined;
  /** The chat registry id (agent-chat.ts `chatRegistryId`): the pin every item and grant names. */
  pin: string;
  projectRoot: string;
  isSuper: boolean;
  /** DREAMCONTEXT_SUPER_CREW was set for it ('1'). */
  superCrew: boolean;
  /** Not a crew process whatever the flags say: the Assistant, a card, an app's chat. */
  excluded: boolean;
  /** A member's own Super: the member's slug. */
  agent?: string;
  /** A member's child: the member mark (a slug, or the ambiguous mark). */
  memberCrew?: string;
  /** The permission mode the process was launched with. */
  mode: string;
  /** Write a live permission-mode switch into the process; false when it cannot. */
  setMode?: (mode: string) => boolean;
}

export interface CrewSeat {
  readonly pid: number | null;
  readonly pin: string;
  readonly crew: CrewKind;
  readonly member?: string;
  readonly project: string;
  /** The mode the process runs in now, as last reported or switched. */
  readonly mode: string;
  /** Is a binding on disk for it (the process table could be read at spawn)? */
  readonly bound: boolean;
  /** A top-level `system/init` frame: its conversation id joins the binding, its mode is told. */
  init(frame: Record<string, unknown>): void;
  /** The mode changed live (the window's switch, a level narrowing). */
  modeChanged(mode: string): void;
  /** The server is about to write `text` as its own turn (crew handle): never his words. */
  noteServerTurn(text: string): void;
  /** Was this turn text one the server wrote? Consumes the note. */
  takeServerTurn(text: string): boolean;
  /** The process exited: its binding goes first, then the seat. Idempotent. */
  exited(): void;
}

export interface CrewDeps extends StoreOpts {
  sys?: ProcSys;
  now?: () => number;
  log?: (line: string) => void;
}

/** Whose crew a process is, or null when it is none. */
export function crewKindOf(f: Pick<CrewSpawnFacts, 'isSuper' | 'superCrew' | 'excluded' | 'agent' | 'memberCrew'>): { crew: CrewKind; member?: string } | null {
  if (f.excluded || !f.superCrew) return null;
  const slug = (s: string | undefined): string | undefined => (s && s !== AMBIGUOUS && SLUG_RE.test(s) ? s : undefined);
  if (f.isSuper) {
    const member = slug(f.agent);
    return member ? { crew: 'member', member } : { crew: 'main' };
  }
  const member = slug(f.memberCrew);
  return member ? { crew: 'child', member } : { crew: 'child' };
}

const seats = new Map<CrewSeat, { setMode?: (mode: string) => boolean }>();

/** Tests only: the process table and home every seat reads when the caller passes none. */
let testDeps: CrewDeps | null = null;
export function _setCrewDeps(d: CrewDeps | null): void { testDeps = d; }

function realOr(p: string): string {
  try { return realpathSync.native(p); } catch { return p; }
}

/**
 * Open the seat of a crew process at spawn: write its binding (pid, start time, pin, project,
 * crew, member). Null when the process is no crew.
 */
export function openCrewSeat(f: CrewSpawnFacts, given: CrewDeps = {}): CrewSeat | null {
  const deps: CrewDeps = { ...(testDeps ?? {}), ...given };
  const kind = crewKindOf(f);
  if (!kind) return null;
  const sys = deps.sys ?? realProcSys();
  const store: StoreOpts = deps.home ? { home: deps.home } : {};
  const project = realOr(f.projectRoot);
  const pid = typeof f.pid === 'number' && Number.isInteger(f.pid) && f.pid > 1 ? f.pid : null;
  let bound = false;
  if (pid !== null) {
    const startedAt = sys.startTimeOf(pid);
    if (startedAt) {
      try {
        writeBinding({
          pid, startedAt, pin: f.pin, project, crew: kind.crew, conversationIds: [], writtenAt: (deps.now ?? Date.now)(),
          ...(kind.member ? { member: kind.member } : {}),
        }, store);
        bound = true;
      } catch (err) {
        deps.log?.(`crew binding not written: ${String(err).slice(0, 200)}`);
      }
    }
  }
  let mode = f.mode;
  let gone = false;
  const serverTurns: string[] = [];
  const seat: CrewSeat = {
    pid, pin: f.pin, crew: kind.crew, ...(kind.member ? { member: kind.member } : {}), project,
    get mode() { return mode; },
    get bound() { return bound; },
    init(frame) {
      if (gone || frame.type !== 'system' || frame.subtype !== 'init' || frame.parent_tool_use_id) return;
      if (bound && pid !== null && typeof frame.session_id === 'string' && frame.session_id) {
        try { addConversationId(pid, frame.session_id, store); } catch { /* the hook asks again until the next init */ }
      }
      if (typeof frame.permissionMode === 'string' && frame.permissionMode) seat.modeChanged(frame.permissionMode);
    },
    modeChanged(next) {
      if (gone || !next) return;
      mode = next;
      setChatPermissionMode(f.pin, next);
    },
    noteServerTurn(text) {
      const t = text.trim();
      if (!t) return;
      serverTurns.push(t);
      if (serverTurns.length > 8) serverTurns.shift();
    },
    takeServerTurn(text) {
      const at = serverTurns.indexOf(text.trim());
      if (at < 0) return false;
      serverTurns.splice(at, 1);
      return true;
    },
    exited() {
      if (gone) return;
      gone = true;
      if (bound && pid !== null) removeBinding(pid, store);
      bound = false;
      seats.delete(seat);
    },
  };
  seats.set(seat, { ...(f.setMode ? { setMode: f.setMode } : {}) });
  return seat;
}

/** The live seats (tests and the level route). */
export function liveCrewSeats(): CrewSeat[] {
  return [...seats.keys()];
}

/**
 * A member's level was NARROWED to `levelMode` (the level's chat mode): every running process of
 * that member's crew (its Super and its children) in `project` (every project when omitted, a
 * global member) moves to the narrower mode now, where the CLI can be switched live. Returns
 * whether every one of them took it now; false means some apply from their next session start.
 */
export function narrowLiveMember(member: string, levelMode: string, project?: string): { now: boolean; moved: number } {
  const where = project === undefined ? undefined : realOr(project);
  let now = true;
  let moved = 0;
  for (const [seat, h] of seats) {
    if (seat.member !== member || (where !== undefined && seat.project !== where)) continue;
    const next = narrowerMode(seat.mode, levelMode);
    if (next === seat.mode) continue;
    if (!LIVE_TARGETS.has(next) || !h.setMode) { now = false; continue; }
    let ok = false;
    try { ok = h.setMode(next); } catch { ok = false; }
    if (!ok) { now = false; continue; }
    seat.modeChanged(next);
    moved += 1;
  }
  return { now, moved };
}

/** Tests only. */
export function _resetCrewSeats(): void {
  seats.clear();
}
