/**
 * Client rules for a Codex pane (Track T W1 end review): a Codex chat always resumes as a chat
 * (it has no terminal surface), and an Edit card draws a Codex unified diff, headers skipped only
 * before the first hunk.
 */
import { describe, expect, it } from 'vitest';
import { resumePlan } from '../../../dashboard/src/components/sleepy/chatLaunch';
import { parseEditDiff } from '../../../dashboard/src/components/sleepy/chat/chatEntities';

describe('a Codex pane on the client', () => {
  it('resumes as a chat even under the Terminal agent screen, in Basic mode', () => {
    expect(resumePlan({ kind: 'chat', tool: 'codex' }, 'agent').asChat).toBe(true);
    // A plain Claude chat with no mode still follows the screen, as before.
    expect(resumePlan({ kind: 'chat' }, 'agent').asChat).toBe(false);
  });

  it('draws a unified diff; `--`/`++` inside a hunk are content, not headers', () => {
    const patch = ['--- a/q.sql', '+++ b/q.sql', '@@ -1,2 +1,2 @@', '-- old comment', '-select 1;', '++i;', '+select 2;'].join('\n');
    expect(parseEditDiff({ file_path: 'q.sql', patch })).toEqual({
      removed: ['- old comment', 'select 1;'], added: ['+i;', 'select 2;'], addedN: 2, removedN: 2,
    });
    expect(parseEditDiff({ file_path: 'q.sql', patch: '--- a\n+++ b' })).toBeNull();
  });
});
