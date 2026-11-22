import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, existsSync, realpathSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { ecoPlusDispatchModel, definitionModel } from '../../src/lib/eco-plus-dispatch.js';

/** Plan eco-plus D6 / criterion 5: the Agent dispatch hook's model rewrite. */
const agent = (dir: string, name: string, model: string | null) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), `---\nname: ${name}\ndescription: x\n${model ? `model: ${model}\n` : ''}tools: Read\n---\nbody\n`);
};

describe('ecoPlusDispatchModel', () => {
  let base: string;
  let project: string;
  let home: string;
  let worktree: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'eco-plus-hook-')));
    project = join(base, 'project');
    home = join(base, 'home');
    worktree = join(base, 'worktree');
    mkdirSync(worktree, { recursive: true });
    const pa = join(project, '.claude', 'agents');
    agent(pa, 'goal-implementer', 'opus');
    agent(pa, 'goal-validator', 'opus');
    agent(pa, 'sleep-product', 'claude-opus-5');
    agent(pa, 'sleep-state', 'claude-sonnet-5');
    agent(pa, 'dreamcontext-explore', 'haiku');
    agent(pa, 'reviewer', 'opus');
    agent(pa, 'review-security', 'opus');
    agent(pa, 'goal-plan-reviewer', 'opus');
    agent(pa, 'no-model', null);
    agent(pa, 'fox', 'opus'); // collides with a member slug
    agent(join(home, '.claude', 'agents'), 'home-only', 'fable');
    agent(join(home, '.claude', 'agents'), 'no-model', 'opus'); // the project file (no model) wins
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));
  const deps = () => ({ projectDir: project, home, memberSlugs: () => ['fox'] });
  const run = (input: Record<string, unknown>, on = true) => ecoPlusDispatchModel(input, on, deps());

  it('lowers an explicit Opus param and an Opus/Fable definition with no param', () => {
    expect(run({ subagent_type: 'goal-validator', model: 'opus', prompt: 'x' })).toEqual({ model: 'sonnet', from: 'opus' });
    expect(run({ subagent_type: 'goal-implementer', prompt: 'x' })).toEqual({ model: 'sonnet', from: 'opus' });
    expect(run({ subagent_type: 'sleep-product', prompt: 'x' })).toEqual({ model: 'sonnet', from: 'claude-opus-5' });
    expect(run({ subagent_type: 'home-only', prompt: 'x' })).toEqual({ model: 'sonnet', from: 'fable' });
    expect(run({ subagent_type: 'general-purpose', model: 'claude-opus-5-5', prompt: 'x' })).toEqual({ model: 'sonnet', from: 'claude-opus-5-5' });
  });

  it('keeps the judges, Sonnet/Haiku types, unknown types, no-model types and member slugs', () => {
    for (const t of ['reviewer', 'review-security', 'goal-plan-reviewer']) {
      expect(run({ subagent_type: t, prompt: 'x' })).toBeNull();
      expect(run({ subagent_type: t, model: 'opus', prompt: 'x' })).toBeNull();
    }
    expect(run({ subagent_type: 'sleep-state', prompt: 'x' })).toBeNull();
    expect(run({ subagent_type: 'dreamcontext-explore', prompt: 'x' })).toBeNull();
    expect(run({ subagent_type: 'unknown-type', prompt: 'x' })).toBeNull();
    expect(run({ subagent_type: 'no-model', prompt: 'x' })).toBeNull();
    expect(run({ subagent_type: 'fox', prompt: 'x' })).toBeNull();
    expect(run({ subagent_type: 'plugin:thing', prompt: 'x' })).toBeNull();
    expect(run({ subagent_type: 'goal-validator', model: 'sonnet', prompt: 'x' })).toBeNull();
    expect(run({ subagent_type: 'goal-validator', model: 'haiku', prompt: 'x' })).toBeNull();
  });

  it('is off = nothing, and a symlinked definition is untouched', () => {
    expect(run({ subagent_type: 'goal-implementer', prompt: 'x' }, false)).toBeNull();
    const pa = join(project, '.claude', 'agents');
    agent(join(base, 'elsewhere'), 'linked', 'opus');
    symlinkSync(join(base, 'elsewhere', 'linked.md'), join(pa, 'linked.md'));
    expect(definitionModel(pa, 'linked')).toBeNull();
    expect(run({ subagent_type: 'linked', prompt: 'x' })).toBeNull();
    expect(definitionModel(pa, 'missing')).toBeUndefined();
  });

  it('never reads the cwd: with no project dir only ~/.claude/agents counts', () => {
    const r = ecoPlusDispatchModel({ subagent_type: 'goal-implementer', prompt: 'x' }, true, { projectDir: null, home });
    expect(r).toBeNull();
  });
});

/** The real hook (built CLI): the rewrite merges with the prompt append, also with nothing appended. */
describe('pre-tool-use hook, Eco Plus', () => {
  const cli = resolve(import.meta.dirname, '../../dist/index.js');
  let base: string;
  beforeEach(() => { base = realpathSync(mkdtempSync(join(tmpdir(), 'eco-plus-hook-e2e-'))); });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  const setup = (ecoPlus: boolean) => {
    const home = join(base, 'home');
    const project = join(base, 'project');
    const worktree = join(base, 'worktree');
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ ecoMode: true, ecoPlus }));
    agent(join(project, '.claude', 'agents'), 'goal-implementer', 'opus');
    agent(join(project, '.claude', 'agents'), 'reviewer', 'opus');
    mkdirSync(worktree, { recursive: true });
    return { home, project, worktree };
  };
  const hook = (p: ReturnType<typeof setup>, toolInput: Record<string, unknown>, tool = 'Agent') => {
    const r = spawnSync(process.execPath, [cli, 'hook', 'pre-tool-use'], {
      cwd: p.worktree,
      input: JSON.stringify({ tool_name: tool, tool_input: toolInput, cwd: p.worktree, session_id: 'eco-plus-test' }),
      encoding: 'utf-8',
      env: { ...process.env, HOME: p.home, CLAUDE_PROJECT_DIR: p.project, DREAMCONTEXT_CONTEXT_BY: '' },
    });
    const out = r.stdout.trim();
    return out ? (JSON.parse(out) as { hookSpecificOutput?: { updatedInput?: Record<string, unknown> } }).hookSpecificOutput?.updatedInput ?? null : null;
  };

  it.skipIf(!existsSync(cli))('on: a frontmatter-opus dispatch from a worktree cwd gets model sonnet, the prompt kept', () => {
    const p = setup(true);
    const u = hook(p, { subagent_type: 'goal-implementer', description: 'd', prompt: 'build it' });
    expect(u?.model).toBe('sonnet');
    expect(u?.prompt).toBe('build it');
    expect(u?.subagent_type).toBe('goal-implementer');
    expect(hook(p, { subagent_type: 'reviewer', description: 'd', prompt: 'review' })?.model).toBeUndefined();
    expect(hook(p, { subagent_type: 'goal-implementer', description: 'd', prompt: 'x' }, 'Task')?.model).toBe('sonnet');
    const log = readFileSync(join(p.home, '.dreamcontext', 'eco-plus-lowered.jsonl'), 'utf-8');
    expect(log).toContain('"agentType":"goal-implementer"');
  });

  it.skipIf(!existsSync(cli))('off: no model key is written and agent definitions never change', () => {
    const p = setup(false);
    const dir = join(p.project, '.claude', 'agents');
    const sums = () => readdirSync(dir).map((f) => createHash('sha256').update(readFileSync(join(dir, f))).digest('hex') + statSync(join(dir, f)).size);
    const before = sums();
    expect(hook(p, { subagent_type: 'goal-implementer', description: 'd', prompt: 'x' })?.model).toBeUndefined();
    writeFileSync(join(p.home, '.dreamcontext', 'agent-ui.json'), JSON.stringify({ ecoMode: true, ecoPlus: true }));
    expect(hook(p, { subagent_type: 'goal-implementer', description: 'd', prompt: 'x' })?.model).toBe('sonnet');
    expect(sums()).toEqual(before);
  });
});
