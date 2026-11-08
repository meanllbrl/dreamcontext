/**
 * A member's Super hands off into ITS own file (plan-r10 1): `state/.super/members/<slug>.handoff.md`.
 * "New session" on a member's Super writes it and reads it; the rotation record names it; a member
 * never reads main's handoff and main never a member's. Scratch vault only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUPER_STATE_REL, resetSuperIndex, withSuperState } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import {
  SUPER_HANDOFF_TASK, readSuperHandoff, renderSuperHandoffEntry, superHandoffFileOf, superHandoffPath, superHandoffTask, writeSuperHandoff,
} from '../../src/lib/super/handoff-file.js';
import { superHandoffContext, superNudgeLine } from '../../src/lib/super/handoff-task.js';
import { handoffContinuePrompt, readHandoffRecord, renderHandoffBanner, type HandoffRecord } from '../../src/lib/context-watch.js';
import { handleRotationAtResult } from '../../src/server/routes/handoff-rotation.js';
import { _resetFreshSession, markFreshDelivered } from '../../src/lib/super/fresh-session.js';

let dir: string;
let root: string;
const MAIN = 'sess-main-h';
const ROTA = 'sess-rota-h';
const MAIN_FILE = '_dream_context/state/.super/handoff.md';
const ROTA_FILE = '_dream_context/state/.super/members/rota.handoff.md';

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-member-handoff-')));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  resetSuperIndex();
  _resetFreshSession();
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: MAIN, enabled: true }));
  await withSuperState(root, 'm:rota', (s) => { s.session = ROTA; s.enabled = true; });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('a member Super\'s own handoff file', () => {
  it('the record task and the file it names are the member\'s; main\'s stay main\'s', () => {
    expect(superHandoffTask('main')).toBe(SUPER_HANDOFF_TASK);
    expect(superHandoffTask('m:rota')).toBe('.super/members/rota.handoff');
    expect(superHandoffFileOf(superHandoffTask('m:rota'))).toBe(ROTA_FILE);
    expect(superHandoffFileOf(SUPER_HANDOFF_TASK)).toBe(MAIN_FILE);
    expect(superHandoffPath(root, 'm:rota')).toBe(join(root, 'state', '.super', 'members', 'rota.handoff.md'));
  });

  it('`super handoff` from the member\'s session writes ITS file; main\'s is never written or read', () => {
    const ctx = superHandoffContext(root, [ROTA]);
    expect(ctx?.superId).toBe('m:rota');
    expect(superHandoffContext(root, [MAIN])?.superId).toBeUndefined();
    expect(superNudgeLine(ctx!)).toContain(ROTA_FILE);
    writeSuperHandoff(root, [renderSuperHandoffEntry('2026-11-02T10:00:00.000Z', {} as never, 'rota note')], new Date(), ctx!.superId);
    expect(readSuperHandoff(root, 'm:rota')).toContain('rota note');
    expect(readSuperHandoff(root, 'main')).toBeNull();
    expect(existsSync(superHandoffPath(root))).toBe(false);
  });

  it('the fresh session is told to read its own file: the member\'s prompt and banner never name main\'s', () => {
    const member: HandoffRecord = { task: superHandoffTask('m:rota'), title: 'Super Agent', at: new Date().toISOString(), contextTokens: null, fromSession: ROTA, tab: ROTA, kind: 'super' };
    const main: HandoffRecord = { ...member, task: SUPER_HANDOFF_TASK, fromSession: MAIN, tab: MAIN };
    expect(handoffContinuePrompt(member)).toContain(ROTA_FILE);
    expect(handoffContinuePrompt(member)).not.toContain(MAIN_FILE);
    expect(renderHandoffBanner(member)).toContain(ROTA_FILE);
    expect(handoffContinuePrompt(main)).toContain(MAIN_FILE);
    expect(handoffContinuePrompt(main)).not.toContain('members/');
  });

  it('"New session" on a member\'s Super with no handoff of its own: the fallback record names the member\'s file', () => {
    markFreshDelivered(ROTA, 'b-1');
    const turns: string[] = [];
    const decision = handleRotationAtResult({
      contextRoot: root, pane: ROTA, isSuper: true, frame: { type: 'result' }, isLimit: false,
      observedConversation: ROTA, lastMainContext: 0, writeUserTurn: (t) => turns.push(t), startRun: () => {},
    });
    expect(decision).toBe('fallback');
    expect(readHandoffRecord(root, ROTA)?.task).toBe('.super/members/rota.handoff');
    expect(turns[1]).toContain(ROTA_FILE);
    expect(turns[1]).not.toContain(MAIN_FILE);
  });
});
