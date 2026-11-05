/**
 * Owner 2026-11-05: a Bypass chat asked for a Bash heredoc with a code dump and a generic
 * "this one still needs you". Claude Code 2.1.318 sends its own reason with the request
 * (`decision_reason`, `decision_reason_type: safetyCheck`, `suppress_always_allow_rule`); the
 * request below is the one captured from the CLI for `cat > f <<'EOF' … p.$$(".phone") … EOF`.
 *
 *  - the reason becomes one plain line (or none on a surface that does not know the mode);
 *  - "Run here" is promoted only for a command that asks at the keyboard;
 *  - the client parser, the server registry and the Super's line all carry the reason;
 *  - a suppressed request is never answered by an earlier "always allow" tick;
 *  - the chat briefing tells agents to write scripts to a file instead of a heredoc.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { permissionReasonLine, looksInteractive } from '../../dashboard/src/components/sleepy/chat/permissionReason.js';
import { toChatEvent } from '../../dashboard/src/lib/chatProtocol.js';
import { readPendingQuestion } from '../../src/lib/assistant/chat-registry.js';
import { PERMISSION_LINE } from '../../src/lib/super/inbox.js';
import { CHAT_SURFACE_BRIEFING } from '../../src/server/chat-surface.js';

const CAPTURED = {
  type: 'control_request',
  request_id: '76d999cc-f1a5-4c47-9f7d-7daf0f0a8c90',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Bash',
    display_name: 'Bash',
    input: { command: "cat > /tmp/qae/i.txt <<'EOF'\nconst r = await p.$$(\".phone\")\nEOF", description: 'Write one line of text to i.txt' },
    description: 'Write one line of text to i.txt',
    permission_suggestions: [],
    decision_reason: 'Dangerous rm operation not ruled out — the shell may read this command differently than it was parsed',
    decision_reason_type: 'safetyCheck',
    classifier_approvable: false,
    tool_use_id: 'toolu_018eo7AbBckvxJxgEcV2Mtbp',
    suppress_always_allow_rule: true,
  },
};

describe('permissionReasonLine: one plain line, from the CLI\'s own reason', () => {
  it('the captured safety check reads as "can\'t rule out a delete"', () => {
    expect(permissionReasonLine({ reason: CAPTURED.request.decision_reason, reasonType: 'safetyCheck', mode: 'bypass' })).toEqual({ key: 'perm.reason.rm' });
  });
  it('a parse failure, a path outside the project, a protected file, a hook', () => {
    expect(permissionReasonLine({ reason: 'Commands that change directories and write via output redirection require explicit approval to ensure paths are evaluated correctly. For security, Claude Code cannot automatically determine the final working directory' })).toEqual({ key: 'perm.reason.unparsed' });
    expect(permissionReasonLine({ reason: 'Path is outside the allowed working directories for this session' })).toEqual({ key: 'perm.reason.outside' });
    expect(permissionReasonLine({ reason: 'Writes to .git/hooks require approval' })).toEqual({ key: 'perm.reason.protected' });
    expect(permissionReasonLine({ reasonType: 'hook' })).toEqual({ key: 'perm.reason.hook' });
  });
  it('an unknown reason falls back to its first sentence, clipped', () => {
    const line = permissionReasonLine({ reason: 'Something new happened. Second sentence.' });
    expect(line).toEqual({ text: 'Something new happened.' });
    const long = permissionReasonLine({ reason: 'x'.repeat(300) });
    expect('text' in (long ?? {}) && (long as { text: string }).text.length).toBe(110);
  });
  it('no reason: the mode says it, and with no mode (the phone) no line at all', () => {
    expect(permissionReasonLine({ mode: 'bypass' })).toEqual({ key: 'perm.reason.bypass' });
    expect(permissionReasonLine({ mode: 'auto' })).toEqual({ key: 'perm.reason.auto' });
    expect(permissionReasonLine({})).toBeNull();
  });
});

describe('looksInteractive: "Run here" beside Allow only for a command that asks', () => {
  it.each(['sudo rm /etc/x', 'firebase login', 'npm login', 'gh auth login', 'ssh host', 'read -p "go?" a'])('%s asks', (c) => {
    expect(looksInteractive(c)).toBe(true);
  });
  it.each([CAPTURED.request.input.command, 'node crop.mjs && python3 -c "print(1)"', 'git commit -m "fix sign copy"'])('%s does not', (c) => {
    expect(looksInteractive(c)).toBe(false);
  });
});

describe('the reason travels', () => {
  it('the chat parser keeps reason, kind and the always-allow suppression', () => {
    const ev = toChatEvent(CAPTURED);
    expect(ev).toMatchObject({
      kind: 'permission-request',
      decisionReason: CAPTURED.request.decision_reason,
      decisionReasonType: 'safetyCheck',
      suppressAlwaysAllow: true,
    });
  });
  it('the server registry keeps description, reason and kind (capped)', () => {
    const q = readPendingQuestion(CAPTURED);
    expect(q).toMatchObject({ isPermission: true, description: 'Write one line of text to i.txt', reason: CAPTURED.request.decision_reason, reasonType: 'safetyCheck' });
    const odd = readPendingQuestion({ ...CAPTURED, request: { ...CAPTURED.request, decision_reason_type: 'not a type!' } });
    expect(odd?.reasonType).toBeUndefined();
  });
  it('the chat session never answers a suppressed request from an earlier "always allow"', () => {
    const src = readFileSync(fileURLToPath(new URL('../../dashboard/src/components/sleepy/chatSession.ts', import.meta.url)), 'utf-8');
    expect(src).toContain('sessionAllow.has(ev.toolName) && !ev.requiresInteraction && !ev.suppressAlwaysAllow');
  });
});

describe('the rules the agents read', () => {
  it('the Super may allow temp-folder scripting and reads Claude Code\'s caution as caution', () => {
    expect(PERMISSION_LINE).toContain('the system temp folder (/tmp, $TMPDIR)');
    expect(PERMISSION_LINE).toContain('Why Claude Code asks');
    // Still the owner's: anything outward, irreversible or unseen.
    for (const s of ['any push, publish or merge into the default branch', 'sending anything outward', 'cut short (ending in …)', 'any write into a .git or .claude folder', 'deletes nothing outside its worktree or the temp folder', 'or when unsure']) {
      expect(PERMISSION_LINE).toContain(s);
    }
  });
  it('the chat briefing sends scripts to a file, never a heredoc', () => {
    expect(CHAT_SURFACE_BRIEFING).toContain('## Scripts');
    expect(CHAT_SURFACE_BRIEFING).toContain('goes into a file (Write tool), then Bash runs it; never a heredoc');
  });
});
