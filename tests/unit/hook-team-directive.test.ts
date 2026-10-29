/**
 * The prompt hook's AI TEAM MEMBER line, through the built CLI (`hook user-prompt-submit`), on the
 * eval's Orbit fixture: only with DREAMCONTEXT_TEAM_ROUTE super|offer, only on the owner's own
 * words (never a [super events] turn, a ↩ quote or a held digest), only for a member callable on
 * that route; recall's own input is unchanged but for `<super-team>` blocks.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliWithStdin } from '../helpers/cli-stdin.js';
import { makeTeamProject, type TeamProject } from '../../eval/super-team-routing/setup.js';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');
/** The exact `prompt` a UserPromptSubmit hook received for a three-block stream-json message
 *  (recorded live, claude 2026-10-29): the blocks joined by a newline. */
const MULTI_BLOCK_PROMPT = 'What is this month\'s revenue?\n<owner-msg ref="abc123"/>\n<super-team fp=aaaaaaaaaaaa>\n## Your AI Team\n</super-team>';

let root: string;
let team: TeamProject;
let bare: TeamProject;

function hook(tp: TeamProject, prompt: string, route?: string): string {
  const env: NodeJS.ProcessEnv = {
    ...process.env, HOME: tp.home, DREAMCONTEXT_VERSION_CHECK: '0', DREAMCONTEXT_RECALL_MODE: 'raw', DREAMCONTEXT_AUTO_UPGRADE: '0',
    // The walk for a nested claude stops at this process: the hook is not nested in a test.
    DREAMCONTEXT_SERVER_PID: String(process.pid),
  };
  delete env.DREAMCONTEXT_TEAM_ROUTE;
  delete env.CLAUDE_CODE_SESSION_ID;
  if (route !== undefined) env.DREAMCONTEXT_TEAM_ROUTE = route;
  return runCliWithStdin(CLI, ['hook', 'user-prompt-submit'], JSON.stringify({ session_id: 'sess-team', prompt }), { cwd: tp.proj, env, timeout: 20_000, withStderr: true });
}
const teamLines = (out: string): string[] => out.split('\n').filter((l) => l.includes('AI TEAM MEMBER') || l.includes('(AI Team) watches'));
/** The recall block of an output (its header to the next blank line). */
const recallOf = (out: string): string => {
  const at = out.indexOf('— Memory recall');
  return at < 0 ? '' : out.slice(at, out.indexOf('\n\n', at) < 0 ? undefined : out.indexOf('\n\n', at));
};

beforeAll(() => {
  if (!existsSync(CLI)) throw new Error('build the CLI first (npm run build:cli)');
  root = mkdtempSync(join(tmpdir(), 'dc-hook-team-'));
  team = makeTeamProject(root, { team: true });
  bare = makeTeamProject(root, { team: false });
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('hook user-prompt-submit: the AI TEAM MEMBER line', () => {
  it('super route: the owner\'s words in a ready member\'s field name it and super team ask', () => {
    const lines = teamLines(hook(team, 'Run the signup funnel test end to end', 'super'));
    expect(lines).toEqual(['  → AI TEAM MEMBER `probe` (Probe): this is its field: `dreamcontext super team ask probe "<the job>"`, not a child or your own answer.']);
  });

  it('nothing without the env, or with it empty (terminals, runs, a Super child)', () => {
    expect(teamLines(hook(team, 'Run the signup funnel test end to end'))).toEqual([]);
    expect(teamLines(hook(team, 'Run the signup funnel test end to end', ''))).toEqual([]);
  });

  it('the multi-block owner message as the hook really gets it: matched on his words only', () => {
    expect(teamLines(hook(team, MULTI_BLOCK_PROMPT, 'super'))[0]).toContain('AI TEAM MEMBER `ledger`');
  });

  it('nothing on a [super events] turn, a held event=done digest, or a ↩ quote', () => {
    expect(teamLines(hook(team, '[super events] batch=b items=1\n- item=q1 team=team-1 member=probe event=done awaited=owner status=done\nAnswer: the signup funnel test end to end passed', 'super'))).toEqual([]);
    expect(teamLines(hook(team, 'thanks, go on\n<owner-msg ref="abc123"/>\n<super-while-you-asked>\n- item=q1 team=team-1 member=probe event=done Answer: signup funnel test end to end passed\n</super-while-you-asked>', 'super'))).toEqual([]);
    expect(teamLines(hook(team, '[Reply to message ref=abc123 from=super]\nquote: "Probe ran the signup funnel test end to end"\nok, thanks', 'super'))).toEqual([]);
  });

  it('offer route: the member the chat can call; never one waiting for approval', () => {
    expect(teamLines(hook(team, 'Run the signup funnel test end to end', 'offer'))).toEqual(['  → AI TEAM MEMBER `probe` (Probe): this is its field: offer the owner to ask it before you do its job yourself.']);
    expect(teamLines(hook(team, "Rewrite the pricing funnel's first three screens", 'offer'))).toEqual([]);
  });

  it('an off member gets no line', () => {
    const off = makeTeamProject(root, { team: true });
    const file = join(off.contextRoot, 'automations', 'probe.md');
    writeFileSync(file, readFileSync(file, 'utf-8').replace('enabled: true', 'enabled: false'));
    expect(teamLines(hook(off, 'Run the signup funnel test end to end', 'super'))).toEqual([]);
  });

  it('recall\'s input: a <super-team> block is cut; a team-less Super\'s output is byte-identical to no route', () => {
    const plain = "What's this month's revenue and the MRR now?";
    const withBlock = `${plain}\n<super-team fp=aaaaaaaaaaaa>\n## Your AI Team <!-- fp=aaaaaaaaaaaa -->\n- \`probe\` signup funnel test end to end lookout competitors ads\n</super-team>`;
    expect(recallOf(hook(team, withBlock))).toBe(recallOf(hook(team, plain)));
    const q = 'Fix the invite API endpoint and the onboarding title typo';
    expect(hook(bare, q, 'super')).toBe(hook(bare, q));
  });
});
