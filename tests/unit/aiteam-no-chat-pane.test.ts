/**
 * AC2 guard (plan-r10 1, 4): a member's conversation is its Super stage, so nothing under
 * dashboard/src/components/aiteam/ mounts a chat pane of its own: no ChatPane / ChatPaneHost, no
 * live chat session (createChatSession, chatSession.ts) and no spawn. Read-only run views (RunView,
 * built on the stage's own ChildTranscript) stay allowed: they start no process.
 *
 * Written to the END state of Wave 3: it goes green once the lead deletes aiteam/AgentStage.tsx and
 * aiteam/stageSession.ts at the close. Until then those two files are the only reds it names.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const DIR = join(ROOT, 'dashboard/src/components/aiteam');

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** What mounting a chat pane takes: the pane itself, a live chat session, or a spawn. */
const CHAT_PANE = [
  /from ['"][./]*\/?(?:sleepy\/)?ChatPane(?:Host)?['"]/,
  /from ['"][^'"]*sleepy\/ChatPane(?:Host)?['"]/,
  /from ['"][^'"]*\/chatSession['"]/,
  /from ['"]\.\/stageSession['"]/,
  /\bcreateChatSession\s*\(/,
  /<ChatPane(?:Host)?\b/,
];

describe('nothing under components/aiteam/ mounts a chat pane', () => {
  const files = filesUnder(DIR);
  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });
  for (const file of files) {
    const rel = file.slice(ROOT.length + 1);
    it(rel, () => {
      const src = readFileSync(file, 'utf-8');
      const hits = CHAT_PANE.filter((re) => re.test(src)).map(String);
      expect(hits, `${rel} mounts a chat pane`).toEqual([]);
    });
  }
  it('the retired chat surfaces are gone', () => {
    const names = new Set(readdirSync(DIR));
    expect(names.has('AgentStage.tsx')).toBe(false);
    expect(names.has('stageSession.ts')).toBe(false);
  });
  it('the Chat surface no longer imports the AI Team stage (the superPeek member arm is gone)', () => {
    const surface = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/AgentSurface.tsx'), 'utf-8');
    expect(surface).not.toMatch(/aiteam\/AgentStage|AgentConversation|aiteam\/stageSession/);
  });
});
