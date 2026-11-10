/**
 * The owner-reach scenario walk (uye-bildirim criterion 13), one row per situation: the 22 of the
 * plan's `scenarios.md` plus five adversary rows. Each row names the TOOL it runs on, the DRIVER
 * the suite runs it with (real modules, stand-in processes), whether the owner is away, and two
 * columns: `branch` (what 0f0ecdcd did, from the scenario walk) and `plan` (what this build must
 * do). A row with no `plan` verdict is red. Surfaces: bar, Super chat, member badge, Telegram,
 * banner, member's own bot.
 */

export type Surface = 'bar' | 'Super chat' | 'member badge' | 'Telegram' | 'banner' | "member's own bot" | "member's page only" | 'routine thread only';

export interface ReachVerdict {
  sees: Surface[];
  superTold: boolean;
  /** Steps he takes to unblock it (one per item; a question the Super settles is 0). */
  steps: number;
  /** Owner items it took (the same script three times in one job: asked once). */
  asked: number;
}

export interface AdversaryVerdict { allowed: false }

export interface ScenarioRow {
  id: string;
  who: string;
  tool: 'claude' | 'codex' | 'antigravity';
  driver: string;
  /** He is away from the Mac (Telegram carries it). */
  away?: true;
  branch: Partial<ReachVerdict> & { sees: Surface[] } | null;
  plan: ReachVerdict | AdversaryVerdict | null;
}

const v = (sees: Surface[], superTold: boolean, steps: number, asked: number): ReachVerdict => ({ sees, superTold, steps, asked });
const ALL: Surface[] = ['bar', 'Super chat', 'member badge'];

export const SCENARIOS: ScenarioRow[] = [
  { id: 's1', who: 'A global member asks approval to send a Slack DM (`super ask`)', tool: 'claude', driver: 'member-ask', branch: { sees: ALL, steps: 2 }, plan: v(ALL, true, 1, 1) },
  { id: 's2', who: 'Same ask, owner away, phone only', tool: 'claude', driver: 'member-ask-phone', away: true, branch: { sees: [...ALL, 'Telegram'], steps: 1 }, plan: v([...ALL, 'Telegram'], true, 1, 1) },
  { id: 's3', who: 'A project member: the safety check refuses its script, it writes prose and ends', tool: 'claude', driver: 'member-refusal', branch: { sees: [] }, plan: v(ALL, true, 1, 1) },
  { id: 's4', who: 'Same refusal at night, answered from Telegram in the morning', tool: 'claude', driver: 'member-refusal-telegram', away: true, branch: { sees: [] }, plan: v([...ALL, 'Telegram'], true, 1, 1) },
  { id: 's5', who: 'A member\'s child asks a tool permission (owner\'s own work)', tool: 'claude', driver: 'child-permission', branch: { sees: ALL, steps: 2 }, plan: v(ALL, true, 1, 1) },
  { id: 's6', who: 'A member\'s child asks a tool permission on the Super\'s work', tool: 'claude', driver: 'child-permission-main-work', away: true, branch: { sees: [...ALL, 'Telegram'], steps: 1 }, plan: v([...ALL, 'Telegram'], true, 1, 1) },
  { id: 's7', who: 'A member\'s child asks a question the brief settles (Super\'s work)', tool: 'claude', driver: 'child-question-main-work', branch: { sees: [], steps: 0 }, plan: v([], false, 0, 0) },
  { id: 's8', who: 'A member asks the owner something he already told the Super', tool: 'claude', driver: 'member-ask-super-answers', branch: { sees: [...ALL, 'Telegram'], steps: 0 }, plan: v(['bar'], true, 0, 0) },
  { id: 's9', who: 'A member at level Ask gets a permission prompt in its OWN chat', tool: 'claude', driver: 'member-own-permission', branch: { sees: ["member's page only"], steps: 3 }, plan: v(ALL, true, 1, 1) },
  { id: 's10', who: 'A member ends its turn "the owner must decide", job open, nothing asked', tool: 'claude', driver: 'member-stall', branch: { sees: [] }, plan: v(ALL, true, 1, 1) },
  { id: 's11', who: 'The Super Agent\'s own command is refused by the safety check', tool: 'claude', driver: 'main-refusal', branch: { sees: [] }, plan: v(['bar', 'Super chat'], false, 1, 1) },
  { id: 's12', who: 'A Codex child needs an approval with nobody watching', tool: 'codex', driver: 'bridge-refusal', away: true, branch: { sees: [] }, plan: v([...ALL, 'Telegram'], true, 1, 1) },
  { id: 's13', who: 'An Antigravity child of a member asks to edit a file', tool: 'antigravity', driver: 'child-permission-edit', away: true, branch: { sees: [...ALL, 'Telegram'], steps: 1 }, plan: v([...ALL, 'Telegram'], true, 1, 1) },
  { id: 's14', who: 'Night routine does not run: its instructions changed and wait for approval', tool: 'claude', driver: 'routine-awaiting-approval', away: true, branch: { sees: [] }, plan: v([...ALL, 'Telegram'], true, 2, 1) },
  { id: 's15', who: 'Light night routine: three steps refused, run reads "ok"', tool: 'claude', driver: 'routine-denials', away: true, branch: { sees: [] }, plan: v([...ALL, 'Telegram'], true, 1, 1) },
  { id: 's16', who: 'A routine posts a sign-in card only the owner can run', tool: 'claude', driver: 'routine-card', away: true, branch: { sees: ['routine thread only'], steps: 3 }, plan: v([...ALL, 'Telegram'], true, 2, 1) },
  { id: 's17', who: 'Three members hit permissions within a minute, owner away', tool: 'claude', driver: 'three-members', away: true, branch: { sees: [...ALL, 'Telegram'], steps: 1 }, plan: v([...ALL, 'Telegram'], true, 3, 3) },
  { id: 's18', who: 'A member runs the same script for three funnels: asked each time?', tool: 'claude', driver: 'same-script-thrice', branch: { sees: [] }, plan: v(ALL, true, 1, 1) },
  { id: 's19', who: 'A member wants `git push`: an outward command', tool: 'claude', driver: 'member-outward', branch: { sees: ALL, steps: 2 }, plan: v(ALL, true, 1, 1) },
  { id: 's20', who: 'A global member needs him in a project whose Super Agent is off', tool: 'claude', driver: 'main-off', branch: { sees: ["member's page only"], steps: 3 }, plan: v(['member badge', 'banner', "member's own bot"], false, 2, 1) },
  { id: 's21', who: 'dreamcontext\'s own guard tells an agent to use another command', tool: 'claude', driver: 'hook-guidance', branch: { sees: [], steps: 0 }, plan: v([], false, 0, 0) },
  { id: 's22', who: 'A member\'s scheduled run calls the Super-only `super ask`', tool: 'claude', driver: 'routine-question', away: true, branch: { sees: ['routine thread only'], steps: 2 }, plan: v([...ALL, 'Telegram'], true, 1, 1) },
  // Adversary rows: nothing may be allowed.
  { id: 'a1', who: 'A script edited after its rule', tool: 'claude', driver: 'adv-script-edited', branch: null, plan: { allowed: false } },
  { id: 'a2', who: 'A forged environment: a `claude` the agent started itself, no binding', tool: 'claude', driver: 'adv-forged-env', branch: null, plan: { allowed: false } },
  { id: 'a3', who: 'A Telegram rule that was cut (the command did not fit the message)', tool: 'claude', driver: 'adv-telegram-cut', branch: null, plan: { allowed: false } },
  { id: 'a4', who: 'A one-shot file written by hand', tool: 'claude', driver: 'adv-handwritten-once', branch: null, plan: { allowed: false } },
  { id: 'a5', who: 'A wrapper in front of a pinned script', tool: 'claude', driver: 'adv-wrapper', branch: null, plan: { allowed: false } },
];
