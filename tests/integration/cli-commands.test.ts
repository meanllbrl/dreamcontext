import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-cli-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 10000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

describe('CLI commands (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('init', () => {
    it('creates _agent_context/ with core files', () => {
      const output = run('init --yes --name "Test" --description "Test project" --stack "Node.js" --priority "Ship v1"', tmpDir);
      expect(output).toContain('initialized');
      expect(existsSync(join(tmpDir, '_agent_context', 'core', '0.soul.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '_agent_context', 'core', '1.user.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '_agent_context', 'core', '2.memory.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '_agent_context', 'core', 'CHANGELOG.json'))).toBe(true);
      expect(existsSync(join(tmpDir, '_agent_context', 'state'))).toBe(true);
      expect(existsSync(join(tmpDir, '_agent_context', 'knowledge'))).toBe(true);
    });

    it('refuses to init if _agent_context/ already exists', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      const output = run('init --yes --name "Test2" --description "d" --stack "Node" --priority "p"', tmpDir);
      expect(output).toContain('already exists');
    });

    it('soul file contains project name', () => {
      run('init --yes --name "MyProject" --description "A cool project" --stack "TypeScript" --priority "MVP"', tmpDir);
      const soul = readFileSync(join(tmpDir, '_agent_context', 'core', '0.soul.md'), 'utf-8');
      expect(soul).toContain('MyProject');
    });
  });

  describe('tasks', () => {
    beforeEach(() => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    });

    it('creates a task', () => {
      const output = run('tasks create my-task --description "Do the thing" --priority high', tmpDir);
      expect(output).toContain('created');
      expect(existsSync(join(tmpDir, '_agent_context', 'state', 'my-task.md'))).toBe(true);
    });

    it('creates a task with rich template sections', () => {
      run('tasks create rich-task --description "Test rich" --priority medium --why "Testing rich templates"', tmpDir);
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'rich-task.md'), 'utf-8');
      expect(content).toContain('## Why');
      expect(content).toContain('Testing rich templates');
      expect(content).toContain('## User Stories');
      expect(content).toContain('## Acceptance Criteria');
      expect(content).toContain('## Constraints & Decisions');
      expect(content).toContain('## Technical Details');
      expect(content).toContain('## Notes');
      expect(content).toContain('## Changelog');
      expect(content).toContain('related_feature: null');
    });

    it('creates a task without --why and uses default', () => {
      run('tasks create no-why --description "No why" --priority low', tmpDir);
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'no-why.md'), 'utf-8');
      expect(content).toContain('## Why');
      expect(content).toContain('(To be defined)');
    });

    it('inserts into task user_stories section', () => {
      run('tasks create ins-test --description "Test" --priority low', tmpDir);
      const output = run('tasks insert ins-test user_stories "As a user, I want to test inserts"', tmpDir);
      expect(output).toContain('Inserted');
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'ins-test.md'), 'utf-8');
      expect(content).toContain('As a user, I want to test inserts');
    });

    it('inserts into task acceptance_criteria section', () => {
      run('tasks create ac-test --description "Test" --priority low', tmpDir);
      run('tasks insert ac-test acceptance_criteria "Tests pass with 100% coverage"', tmpDir);
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'ac-test.md'), 'utf-8');
      expect(content).toContain('Tests pass with 100% coverage');
    });

    it('inserts into task constraints with auto-date', () => {
      run('tasks create ct-test --description "Test" --priority low', tmpDir);
      run('tasks insert ct-test constraints "No external dependencies"', tmpDir);
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'ct-test.md'), 'utf-8');
      expect(content).toMatch(/\*\*\[\d{4}-\d{2}-\d{2}\]\*\* No external dependencies/);
    });

    it('inserts into task changelog with auto-date header', () => {
      run('tasks create cl-test --description "Test" --priority low', tmpDir);
      run('tasks insert cl-test changelog "Added pagination support"', tmpDir);
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'cl-test.md'), 'utf-8');
      expect(content).toContain('Added pagination support');
      expect(content).toMatch(/### \d{4}-\d{2}-\d{2} - Update/);
    });

    it('rejects unknown task section', () => {
      run('tasks create uk-test --description "Test" --priority low', tmpDir);
      const output = run('tasks insert uk-test invalid_section "content"', tmpDir);
      expect(output).toContain('Unknown section');
    });

    it('inserts into old-format task with createIfMissing', () => {
      // Create a minimal old-format task (only Changelog section)
      const stateDir = join(tmpDir, '_agent_context', 'state');
      const oldContent = `---
id: "task_old123"
name: "old-task"
description: "Old format task"
priority: "medium"
status: "todo"
created_at: "2026-01-01"
updated_at: "2026-01-01"
tags: []
parent_task: null
---

## Changelog
<!-- LIFO: newest entry at top -->

### 2026-01-01 - Created
- Task created.
`;
      writeFileSync(join(stateDir, 'old-task.md'), oldContent, 'utf-8');
      const output = run('tasks insert old-task notes "Edge case found"', tmpDir);
      expect(output).toContain('Inserted');
      const content = readFileSync(join(stateDir, 'old-task.md'), 'utf-8');
      expect(content).toContain('## Notes');
      expect(content).toContain('Edge case found');
    });

    it('logs progress to a task', () => {
      run('tasks create log-test --description "Test" --priority low', tmpDir);
      run('tasks log log-test "Implemented feature X"', tmpDir);
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'log-test.md'), 'utf-8');
      expect(content).toContain('Implemented feature X');
    });

    it('completes a task', () => {
      run('tasks create done-task --description "Test" --priority low', tmpDir);
      run('tasks complete done-task "All done"', tmpDir);
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'done-task.md'), 'utf-8');
      expect(content).toContain('status: completed');
      expect(content).toContain('All done');
    });

    it('creates a task with no flags (uses defaults, no prompts)', () => {
      const output = run('tasks create defaults-test', tmpDir);
      expect(output).toContain('created');
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'defaults-test.md'), 'utf-8');
      expect(content).toContain('priority: "medium"');
      expect(content).toContain('status: "todo"');
      expect(content).toContain('description: "defaults-test"');
      expect(content).toContain('tags: []');
    });

    it('creates a task with --status and --tags flags', () => {
      run('tasks create flagged-task -d "Flagged" -p high -s in_progress -t "backend,api"', tmpDir);
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'flagged-task.md'), 'utf-8');
      expect(content).toContain('status: "in_progress"');
      expect(content).toContain('priority: "high"');
      expect(content).toContain('"backend"');
      expect(content).toContain('"api"');
    });

    it('creates a task with --status completed', () => {
      run('tasks create completed-task -d "Done from start" -s completed', tmpDir);
      const content = readFileSync(join(tmpDir, '_agent_context', 'state', 'completed-task.md'), 'utf-8');
      expect(content).toContain('status: "completed"');
    });

    it('rejects invalid status', () => {
      const output = run('tasks create bad-status -s done', tmpDir);
      expect(output).toContain('Status must be one of');
    });

    it('rejects invalid priority', () => {
      const output = run('tasks create bad-prio -p urgent', tmpDir);
      expect(output).toContain('Priority must be one of');
    });

    it('lists non-completed tasks by default', () => {
      run('tasks create active-one -d "Active" -p high -s in_progress', tmpDir);
      run('tasks create backlog-one -d "Backlog" -p low', tmpDir);
      run('tasks create done-one -d "Done" -s completed', tmpDir);
      const output = run('tasks list', tmpDir);
      expect(output).toContain('active-one');
      expect(output).toContain('backlog-one');
      expect(output).not.toContain('done-one');
    });

    it('lists all tasks with --all flag', () => {
      run('tasks create list-all-active -d "A" -p low', tmpDir);
      run('tasks create list-all-done -d "D" -s completed', tmpDir);
      const output = run('tasks list --all', tmpDir);
      expect(output).toContain('list-all-active');
      expect(output).toContain('list-all-done');
    });

    it('filters by status with --status flag', () => {
      run('tasks create status-todo -d "Todo" -p low -s todo', tmpDir);
      run('tasks create status-ip -d "IP" -p low -s in_progress', tmpDir);
      const output = run('tasks list -s in_progress', tmpDir);
      expect(output).toContain('status-ip');
      expect(output).not.toContain('status-todo');
    });

    it('shows no active tasks message when all completed', () => {
      run('tasks create only-done -d "D" -s completed', tmpDir);
      const output = run('tasks list', tmpDir);
      expect(output).toContain('No active tasks');
    });
  });

  describe('features', () => {
    beforeEach(() => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    });

    it('creates a feature', () => {
      const output = run('features create auth --why "Users need to log in"', tmpDir);
      expect(output).toContain('created');
      expect(existsSync(join(tmpDir, '_agent_context', 'core', 'features', 'auth.md'))).toBe(true);
    });

    it('inserts into feature changelog', () => {
      run('features create auth --why "Login"', tmpDir);
      run('features insert auth changelog "Added JWT middleware"', tmpDir);
      const content = readFileSync(join(tmpDir, '_agent_context', 'core', 'features', 'auth.md'), 'utf-8');
      expect(content).toContain('Added JWT middleware');
    });
  });

  describe('knowledge', () => {
    beforeEach(() => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    });

    it('creates a knowledge file with proper YAML (no injection)', () => {
      const output = run('knowledge create "test-topic" --description "A test topic" --tags "ai,agent" --content "Some research"', tmpDir);
      expect(output).toContain('created');
      const file = join(tmpDir, '_agent_context', 'knowledge', 'test-topic.md');
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('name: test-topic');
      expect(content).toContain('Some research');
    });

    it('handles special characters in name without breaking YAML', () => {
      const output = run('knowledge create "test: value" --description "Has colon" --tags "test" --content "Content"', tmpDir);
      expect(output).toContain('created');
      const file = join(tmpDir, '_agent_context', 'knowledge', 'test-value.md');
      const content = readFileSync(file, 'utf-8');
      // Should be valid YAML — gray-matter handles the quoting
      expect(content).toContain('test: value');
    });

    it('creates knowledge file with pinned field', () => {
      run('knowledge create "pinned-test" --description "Test" --tags "test" --content "Content"', tmpDir);
      const file = join(tmpDir, '_agent_context', 'knowledge', 'pinned-test.md');
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('pinned: false');
    });

    it('lists knowledge index in plain mode', () => {
      run('knowledge create "test-topic" --description "A test topic" --tags "ai,agent" --content "Some research"', tmpDir);
      const output = run('knowledge index --plain', tmpDir);
      expect(output).toContain('test-topic: A test topic [ai, agent]');
    });

    it('shows empty message when no knowledge files exist', () => {
      const output = run('knowledge index --plain', tmpDir);
      expect(output).toContain('No knowledge files found');
    });

    it('filters knowledge index by tag', () => {
      run('knowledge create "auth-flow" --description "Auth system" --tags "api,security" --content "Auth details"', tmpDir);
      run('knowledge create "ui-guide" --description "UI patterns" --tags "frontend,design" --content "UI details"', tmpDir);
      run('knowledge create "db-schema" --description "Database schema" --tags "api,database" --content "DB details"', tmpDir);

      const apiOutput = run('knowledge index --plain --tag api', tmpDir);
      expect(apiOutput).toContain('auth-flow');
      expect(apiOutput).toContain('db-schema');
      expect(apiOutput).not.toContain('ui-guide');

      const frontendOutput = run('knowledge index --plain --tag frontend', tmpDir);
      expect(frontendOutput).toContain('ui-guide');
      expect(frontendOutput).not.toContain('auth-flow');
    });

    it('shows empty message when tag filter matches nothing', () => {
      run('knowledge create "test" --description "Test" --tags "api" --content "C"', tmpDir);
      const output = run('knowledge index --plain --tag nonexistent', tmpDir);
      expect(output).toContain('No knowledge files found matching tag "nonexistent"');
    });
  });

  describe('install-skill', () => {
    it('creates settings.json with SessionStart and Stop hooks', () => {
      run('install-skill', tmpDir);
      const settingsPath = join(tmpDir, '.claude', 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks).toBeDefined();
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('npx agentcontext hook session-start');
      expect(settings.hooks.Stop).toBeDefined();
      expect(settings.hooks.Stop).toHaveLength(1);
      expect(settings.hooks.Stop[0].hooks[0].command).toBe('npx agentcontext hook stop');
    });

    it('preserves existing settings when adding hooks', () => {
      // Create existing settings with some other config
      mkdirSync(join(tmpDir, '.claude'), { recursive: true });
      writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
        permissions: { allow: ['Bash(npm test:*)'] },
        hooks: {
          PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo done' }] }],
        },
      }, null, 2), 'utf-8');

      run('install-skill', tmpDir);
      const settings = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'));

      // Existing settings preserved
      expect(settings.permissions.allow).toContain('Bash(npm test:*)');
      // Existing PostToolUse hook preserved + our new one added
      expect(settings.hooks.PostToolUse).toHaveLength(2);
      expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('echo done');
      expect(settings.hooks.PostToolUse[1].hooks[0].command).toBe('npx agentcontext hook post-tool-use');
      // Hooks added
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('npx agentcontext hook session-start');
      expect(settings.hooks.Stop).toHaveLength(1);
    });

    it('migrates old snapshot hook to session-start hook', () => {
      // Create settings with old hook
      mkdirSync(join(tmpDir, '.claude'), { recursive: true });
      writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: 'startup|resume|compact|clear',
            hooks: [{ type: 'command', command: 'npx agentcontext snapshot', timeout: 10 }],
          }],
        },
      }, null, 2), 'utf-8');

      run('install-skill', tmpDir);
      const settings = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'));

      // Old hook replaced, not duplicated
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('npx agentcontext hook session-start');
      // Stop hook also added
      expect(settings.hooks.Stop).toHaveLength(1);
    });

    it('does not duplicate hooks on repeated install', () => {
      run('install-skill', tmpDir);
      run('install-skill', tmpDir);
      const settings = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'));
      expect(settings.hooks.SessionStart).toHaveLength(1);
      expect(settings.hooks.Stop).toHaveLength(1);
      expect(settings.hooks.PostToolUse).toHaveLength(1);
      expect(settings.hooks.PreCompact).toHaveLength(1);
    });

    it('installs PostToolUse and PreCompact hooks', () => {
      run('install-skill', tmpDir);
      const settings = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'));
      expect(settings.hooks.PostToolUse).toBeDefined();
      expect(settings.hooks.PostToolUse).toHaveLength(1);
      expect(settings.hooks.PostToolUse[0].matcher).toBe('Edit|Write');
      expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('npx agentcontext hook post-tool-use');
      expect(settings.hooks.PostToolUse[0].hooks[0].timeout).toBe(30);

      expect(settings.hooks.PreCompact).toBeDefined();
      expect(settings.hooks.PreCompact).toHaveLength(1);
      expect(settings.hooks.PreCompact[0].hooks[0].command).toBe('npx agentcontext hook pre-compact');
      expect(settings.hooks.PreCompact[0].hooks[0].timeout).toBe(5);
    });
  });

  describe('snapshot', () => {
    it('returns empty when no _agent_context/', () => {
      const output = run('snapshot', tmpDir);
      expect(output.trim()).toBe('');
    });

    it('returns full context after init and task creation', () => {
      run('init --yes --name "Snapshot Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      run('tasks create my-task --description "Do stuff" --priority high', tmpDir);
      const output = run('snapshot', tmpDir);
      expect(output).toContain('# Agent Context');
      expect(output).toContain('Snapshot Test');
      expect(output).toContain('my-task');
    });
  });

  describe('doctor', () => {
    it('reports results on initialized project', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      const output = run('doctor', tmpDir);
      expect(output).toContain('ok');
      // Fresh init may have placeholder warnings, but no missing required files
      expect(output).not.toContain('Missing: core/0.soul.md');
      expect(output).not.toContain('Missing: core/1.user.md');
      expect(output).not.toContain('Missing: core/2.memory.md');
    });

    it('reports error when _agent_context/ does not exist', () => {
      const output = run('doctor', tmpDir);
      expect(output).toContain('not found');
    });

    it('reports error on malformed JSON', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      writeFileSync(join(tmpDir, '_agent_context', 'core', 'CHANGELOG.json'), '{ broken', 'utf-8');
      const output = run('doctor', tmpDir);
      expect(output).toContain('Malformed JSON');
    });

    it('reports warning on empty core file', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      writeFileSync(join(tmpDir, '_agent_context', 'core', '0.soul.md'), '', 'utf-8');
      const output = run('doctor', tmpDir);
      expect(output).toContain('Empty file');
    });

    it('reports warning on placeholder content', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      writeFileSync(join(tmpDir, '_agent_context', 'core', '0.soul.md'), '(Add your principles here)', 'utf-8');
      const output = run('doctor', tmpDir);
      expect(output).toContain('placeholder');
    });
  });

  describe('snapshot --tokens', () => {
    it('outputs a number estimating token count', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      const output = run('snapshot --tokens', tmpDir);
      const num = parseInt(output.trim(), 10);
      expect(num).toBeGreaterThan(0);
      expect(num).toBeLessThan(100000);
    });

    it('outputs nothing when no _agent_context/', () => {
      const output = run('snapshot --tokens', tmpDir);
      expect(output.trim()).toBe('');
    });
  });

  describe('feature section validation', () => {
    beforeEach(() => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      run('features create auth --why "Login"', tmpDir);
    });

    it('rejects unknown section name', () => {
      const output = run('features insert auth changlog "Some content"', tmpDir);
      expect(output).toContain('Unknown section');
      expect(output).toContain('changelog');
    });

    it('accepts valid section names', () => {
      const output = run('features insert auth notes "Some note"', tmpDir);
      expect(output).toContain('Inserted');
    });
  });

  describe('ambiguous file matching', () => {
    beforeEach(() => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    });

    it('errors on ambiguous task prefix match', () => {
      run('tasks create auth-ui --description "UI" --priority low', tmpDir);
      run('tasks create auth-backend --description "Backend" --priority low', tmpDir);
      const output = run('tasks log auth- "Some progress"', tmpDir);
      expect(output).toContain('Ambiguous');
      expect(output).toContain('auth-ui');
      expect(output).toContain('auth-backend');
    });

    it('errors on ambiguous feature prefix match', () => {
      run('features create auth-ui --why "UI"', tmpDir);
      run('features create auth-backend --why "Backend"', tmpDir);
      const output = run('features insert auth- changelog "Some change"', tmpDir);
      expect(output).toContain('Ambiguous');
      expect(output).toContain('auth-ui');
      expect(output).toContain('auth-backend');
    });

    it('resolves exact match without ambiguity', () => {
      run('tasks create auth --description "Auth" --priority low', tmpDir);
      run('tasks create auth-ui --description "UI" --priority low', tmpDir);
      const output = run('tasks log auth "Exact match works"', tmpDir);
      expect(output).toContain('Log entry added');
    });
  });

  describe('end-to-end flow', () => {
    it('init → task create → task log → snapshot shows everything', () => {
      // Init
      run('init --yes --name "E2E" --description "End to end test" --stack "TypeScript" --priority "v1"', tmpDir);

      // Create task
      run('tasks create implement-auth --description "Build authentication" --priority high', tmpDir);

      // Log progress
      run('tasks log implement-auth "Added JWT middleware"', tmpDir);

      // Add changelog entry directly (core changelog add is interactive-only)
      const changelogPath = join(tmpDir, '_agent_context', 'core', 'CHANGELOG.json');
      const changelog = JSON.parse(readFileSync(changelogPath, 'utf-8'));
      changelog.unshift({ date: '2026-02-24', type: 'feat', scope: 'auth', description: 'Added JWT authentication', breaking: false });
      writeFileSync(changelogPath, JSON.stringify(changelog, null, 2), 'utf-8');

      // Create feature
      run('features create authentication --why "Users need to log in securely"', tmpDir);

      // Snapshot should contain all of this
      const snapshot = run('snapshot', tmpDir);
      expect(snapshot).toContain('E2E');
      expect(snapshot).toContain('implement-auth');
      expect(snapshot).toContain('todo');
      expect(snapshot).toContain('authentication');
    });
  });

  describe('releases', () => {
    beforeEach(() => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    });

    it('creates a release with --yes', () => {
      const output = run('core releases add --ver 1.0.0 --summary "Initial release" --yes', tmpDir);
      expect(output).toContain('Release 1.0.0 recorded');
      const releases = JSON.parse(readFileSync(join(tmpDir, '_agent_context', 'core', 'RELEASES.json'), 'utf-8'));
      expect(releases[0].version).toBe('1.0.0');
      expect(releases[0].id).toMatch(/^rel_/);
      expect(Array.isArray(releases[0].features)).toBe(true);
      expect(Array.isArray(releases[0].tasks)).toBe(true);
      expect(Array.isArray(releases[0].changelog)).toBe(true);
    });

    it('rejects duplicate version', () => {
      run('core releases add --ver 1.0.0 --summary "First" --yes', tmpDir);
      const output = run('core releases add --ver 1.0.0 --summary "Dup" --yes', tmpDir);
      expect(output).toContain('already exists');
    });

    it('auto-discovers completed tasks', () => {
      run('tasks create auth -d "Build auth" -p high', tmpDir);
      run('tasks complete auth "Done"', tmpDir);
      const output = run('core releases add --ver 1.0.0 --summary "Auth release" --yes', tmpDir);
      expect(output).toContain('1 tasks');
      const releases = JSON.parse(readFileSync(join(tmpDir, '_agent_context', 'core', 'RELEASES.json'), 'utf-8'));
      expect(releases[0].tasks).toHaveLength(1);
      expect(releases[0].tasks[0]).toMatch(/^task_/);
    });

    it('auto-discovers unreleased features and back-populates released_version', () => {
      run('features create auth --why "Login"', tmpDir);
      run('core releases add --ver 1.0.0 --summary "Auth release" --yes', tmpDir);
      const releases = JSON.parse(readFileSync(join(tmpDir, '_agent_context', 'core', 'RELEASES.json'), 'utf-8'));
      expect(releases[0].features).toHaveLength(1);
      // Verify back-population
      const feature = readFileSync(join(tmpDir, '_agent_context', 'core', 'features', 'auth.md'), 'utf-8');
      expect(feature).toContain('released_version');
      expect(feature).toContain('1.0.0');
    });

    it('auto-discovers changelog entries', () => {
      const changelogPath = join(tmpDir, '_agent_context', 'core', 'CHANGELOG.json');
      const entries = JSON.parse(readFileSync(changelogPath, 'utf-8'));
      entries.unshift({ date: '2026-02-25', type: 'feat', scope: 'auth', description: 'Added JWT', breaking: false });
      writeFileSync(changelogPath, JSON.stringify(entries, null, 2), 'utf-8');

      run('core releases add --ver 1.0.0 --summary "Test" --yes', tmpDir);
      const releases = JSON.parse(readFileSync(join(tmpDir, '_agent_context', 'core', 'RELEASES.json'), 'utf-8'));
      // Should include the manually added entry plus the init entry
      expect(releases[0].changelog.length).toBeGreaterThanOrEqual(1);
      expect(releases[0].changelog.some((c: any) => c.description === 'Added JWT')).toBe(true);
    });

    it('does not re-include already-released items', () => {
      run('tasks create task1 -d "T1" -p low', tmpDir);
      run('tasks complete task1 "Done"', tmpDir);
      run('features create feat1 --why "Why"', tmpDir);

      run('core releases add --ver 1.0.0 --summary "R1" --yes', tmpDir);
      run('core releases add --ver 1.1.0 --summary "R2" --yes', tmpDir);

      const releases = JSON.parse(readFileSync(join(tmpDir, '_agent_context', 'core', 'RELEASES.json'), 'utf-8'));
      // v1.1.0 is at index 0 (LIFO), should have empty arrays
      expect(releases[0].version).toBe('1.1.0');
      expect(releases[0].tasks).toHaveLength(0);
      expect(releases[0].features).toHaveLength(0);
      expect(releases[0].changelog).toHaveLength(0);
    });

    it('lists releases', () => {
      run('core releases add --ver 1.0.0 --summary "First" --yes', tmpDir);
      run('core releases add --ver 1.1.0 --summary "Second" --yes', tmpDir);
      const output = run('core releases list', tmpDir);
      expect(output).toContain('1.0.0');
      expect(output).toContain('1.1.0');
    });

    it('shows release details', () => {
      run('core releases add --ver 1.0.0 --summary "Detailed release" --yes', tmpDir);
      const output = run('core releases show 1.0.0', tmpDir);
      expect(output).toContain('1.0.0');
      expect(output).toContain('Detailed release');
    });

    it('errors on show with nonexistent version', () => {
      const output = run('core releases show 9.9.9', tmpDir);
      expect(output).toContain('not found');
    });

    it('includes latest release in snapshot', () => {
      run('core releases add --ver 1.0.0 --summary "First release" --yes', tmpDir);
      const output = run('snapshot', tmpDir);
      expect(output).toContain('Latest Release');
      expect(output).toContain('1.0.0');
      expect(output).toContain('First release');
    });
  });
});
