/**
 * Our instructions, made true for the tool that reads them. The briefing, the prompt hook's own
 * lines, the recipes and the skill files are written for Claude Code: "the Skill tool", "the Agent
 * tool with subagent_type X", "model opus". Codex has none of those names (its sub-agents are
 * `spawn_agent` with an `agent_type`, its skills are files it opens), and Antigravity has no
 * sub-agents at all. Claude never passes through here, so its text stays byte for byte.
 *
 * Only OUR text is rewritten. The owner's brain (the snapshot, recall) is data and is never touched;
 * {@link toolNote} tells the model how to read Claude's names wherever they still appear there.
 */
export type TextTool = 'codex' | 'antigravity';

const MODELS = '(?:opus|sonnet|haiku|fable)';

/** Ordered: the longer phrase first, so a shorter rule never splits it. */
const RULES: Record<TextTool, ReadonlyArray<readonly [RegExp, string]>> = {
  codex: [
    // A sub-agent's model is Claude's: on Codex the role runs on the chat's own model.
    [new RegExp(`\\(Agent tool, model ${MODELS}, `, 'gi'), '(spawn_agent, '],
    [new RegExp(`(?<![-\\w])model ${MODELS}, `, 'gi'), ''],
    [new RegExp(`, model ${MODELS}\\b`, 'gi'), ''],
    [new RegExp(`(?<![-\\w])\\(model ${MODELS}\\)`, 'gi'), ''],
    [/\bvia the Skill tool\b/g, 'by opening its SKILL.md'],
    [/\bthe Skill tool\b/g, 'its SKILL.md'],
    [/\bSkill tool\b/g, 'SKILL.md'],
    [/\bthe Agent tool's\b/g, "spawn_agent's"],
    [/\bthe Agent tool\b/g, 'spawn_agent'],
    [/\bAgent tool\b/g, 'spawn_agent'],
    [/\bsubagent_type\b/g, 'agent_type'],
    [/\bthe Bash tool's `timeout: 600000`/g, 'a 10-minute command timeout'],
    [/\bthe Bash tool's run_in_background\b/g, 'a background shell'],
  ],
  antigravity: [
    [new RegExp(`\\(Agent tool, model ${MODELS}, `, 'gi'), '(the role, '],
    [new RegExp(`(?<![-\\w])model ${MODELS}, `, 'gi'), ''],
    [new RegExp(`, model ${MODELS}\\b`, 'gi'), ''],
    [new RegExp(`(?<![-\\w])\\(model ${MODELS}\\)`, 'gi'), ''],
    [/\bvia the Skill tool\b/g, 'by opening its SKILL.md'],
    [/\bthe Skill tool\b/g, 'its SKILL.md'],
    [/\bSkill tool\b/g, 'SKILL.md'],
    [/\bthe Agent tool's\b/g, "a role's"],
    [/\bthe Agent tool\b/g, 'a role you run yourself'],
    [/\bAgent tool\b/g, 'role'],
    [/\bsubagent_type\b/g, 'role'],
    [/\bthe Bash tool's `timeout: 600000`/g, 'a 10-minute command timeout'],
    [/\bthe Bash tool's run_in_background\b/g, 'a background shell'],
  ],
};

/** `text` with Claude's tool and model names replaced by the tool's own. */
export function toolText(text: string, tool: TextTool): string {
  let out = text;
  for (const [re, to] of RULES[tool]) out = out.replace(re, to);
  return out;
}

/** What a Claude-only phrase looks like; the tests hold every text we send a tool to none of these. */
export const CLAUDE_ONLY = new RegExp(`\\bSkill tool\\b|\\bAgent tool\\b|\\bsubagent_type\\b|(?<![-\\w])model ${MODELS}\\b`, 'i');

/** The tool a CLI command was started from, when a bridge chat said so (DREAMCONTEXT_AGENT_TOOL). */
export function envTextTool(env: NodeJS.ProcessEnv = process.env): TextTool | null {
  const t = env.DREAMCONTEXT_AGENT_TOOL;
  return t === 'codex' || t === 'antigravity' ? t : null;
}

/** Printed text for the tool the command runs under; unchanged on Claude and in a terminal. */
export const forEnvTool = (text: string, env: NodeJS.ProcessEnv = process.env): string => {
  const t = envTextTool(env);
  return t ? toolText(text, t) : text;
};

/** The flows the owner already authorized sub-agents for (hook.ts SUBAGENT_DISPATCH_AUTHORIZATION). */
const FLOWS = 'sleep, curator, initializer, goal-skill, dreamcontext-deep-research, council, multi-review, and the Plan and Develop modes\' clean judges (goal-plan-reviewer, reviewer, goal-validator, review-router, review-*)';

/**
 * How the model reads Claude's names where they remain: in the owner's notes, in a reference file.
 * Rides Codex's developer instructions (trusted, so the sub-agent authorization holds there) and
 * Antigravity's first turn.
 */
export function toolNote(tool: TextTool, o: { roles?: readonly string[]; roleDirs?: readonly string[] } = {}): string {
  const ours = "dreamcontext's skills (dreamcontext, initializer, curator, dream-sync, dreamcontext-deep-research, patterns, apps)";
  const use = "When one covers the work, open its SKILL.md before acting; for a dreamcontext command you are unsure of, open the dreamcontext skill, never guess from the brain's files.";
  const skills = tool === 'codex'
    ? `${ours} and this project's .claude/skills are in your skill list. ${use}`
    : `${ours} are in your skill list; this project's own are .claude/skills/<name>/SKILL.md. ${use}`;
  const models = 'Model names (opus, sonnet, haiku, fable) and a "model" for a sub-agent are Claude\'s: you run on your own model and leave a sub-agent\'s model unset.';
  if (tool === 'codex') {
    const roles = o.roles?.length ? ` Configured roles: ${o.roles.join(', ')}.` : '';
    return [
      '## dreamcontext on Codex',
      `- Skills: ${skills}`,
      `- Sub-agents: where a text says "the Agent tool" or subagent_type X, use spawn_agent with agent_type X.${roles} The owner authorizes sub-agents for these dreamcontext flows: ${FLOWS}. Running one of them IS the owner asking for its sub-agents.`,
      `- ${models} "The Skill tool" means opening that SKILL.md.`,
    ].join('\n');
  }
  const dirs = o.roleDirs?.length ? ` Role files: ${o.roleDirs.join(', ')} (one <role>.md each).` : '';
  return [
    '## dreamcontext on Antigravity',
    `- Skills: ${skills}`,
    `- No sub-agents here: where a text hands work to a role (the Agent tool, subagent_type X), open that role's file and do its work yourself, one role after another, keeping each role's scope.${dirs}`,
    `- ${models} "The Skill tool" means opening that SKILL.md.`,
  ].join('\n');
}
