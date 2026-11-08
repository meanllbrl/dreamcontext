import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanContextDelivery } from '../../src/lib/context-delivery-audit.js';
import { claudeProjectDirName, clearTranscriptSessionCaches } from '../../src/lib/transcript-sessions.js';

const SID = '8a7b6c5d-4e3f-4210-9a8b-7c6d5e4f3a2b';
const PREVIEW = '<persisted-output>\nOutput too large (18.7KB). Full output saved to: /x\n</persisted-output>';

let home: string;
let project: string;
let sessionDir: string;

const hook = (hookEvent: string, content: unknown, type = 'hook_success') =>
  JSON.stringify({ type: 'attachment', attachment: { type, hookEvent, content, stdout: '' } });

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'dc-delivery-audit-')));
  project = join(home, 'acme-shop');
  mkdirSync(project, { recursive: true });
  sessionDir = join(home, '.claude', 'projects', claudeProjectDirName(project));
  mkdirSync(sessionDir, { recursive: true });
  clearTranscriptSessionCaches();
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); clearTranscriptSessionCaches(); });

function session(records: string[], id = SID): void {
  writeFileSync(join(sessionDir, `${id}.jsonl`), `${records.join('\n')}\n`);
}

describe('scanContextDelivery', () => {
  it('nothing to read says so, not that all is well', () => {
    expect(scanContextDelivery(project, home).sessions).toBe(0);
  });

  it('a whole delivery is clean', () => {
    session([hook('SessionStart', 'whole'), hook('UserPromptSubmit', 'whole')]);
    expect(scanContextDelivery(project, home)).toMatchObject({ sessions: 1, previews: {}, missingParts: 0 });
  });

  it('counts previews by event, plain stdout and additionalContext alike', () => {
    session([hook('SessionStart', PREVIEW), hook('UserPromptSubmit', [PREVIEW], 'hook_additional_context')]);
    expect(scanContextDelivery(project, home).previews).toEqual({ SessionStart: 1, UserPromptSubmit: 1 });
  });

  it('reads the sub-agents of a session', () => {
    session([hook('SessionStart', 'whole')]);
    mkdirSync(join(sessionDir, SID, 'subagents'), { recursive: true });
    writeFileSync(join(sessionDir, SID, 'subagents', 'agent-a1.jsonl'), `${hook('SubagentStart', [PREVIEW], 'hook_additional_context')}\n`);
    expect(scanContextDelivery(project, home)).toMatchObject({ subagents: 1, previews: { SubagentStart: 1 } });
  });

  it('a promised part that never came is a lost part; one that came is not', () => {
    const first = 'head\n\n_Project context continues in part 2 of 2, delivered beside this one._';
    session([hook('SessionStart', first)]);
    expect(scanContextDelivery(project, home).missingParts).toBe(1);
    session([hook('SessionStart', first), hook('SessionStart', '_Project context, part 2 of 2, continued._\n\ntail')]);
    expect(scanContextDelivery(project, home).missingParts).toBe(0);
  });

  it('ignores other events and a line that will not parse', () => {
    session(['{broken', hook('PostToolUse', PREVIEW)]);
    expect(scanContextDelivery(project, home).previews).toEqual({});
  });
});
