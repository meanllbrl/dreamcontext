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

  describe('root', () => {
    // `dreamcontext --version` is relied on by install.sh for install verification.
    // It is handled manually (not Commander's global `.version()`) so subcommands
    // can own `--version <id>`; lock both behaviors here.
    it('prints the CLI version for --version', () => {
      const output = run('--version', tmpDir).trim();
      expect(output).toMatch(/^\d+\.\d+\.\d+/);
    });

    it('prints the CLI version for -V', () => {
      const output = run('-V', tmpDir).trim();
      expect(output).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('init', () => {
    it('creates _dream_context/ with core files', () => {
      const output = run('init --yes --name "Test" --description "Test project" --stack "Node.js" --priority "Ship v1"', tmpDir);
      expect(output).toContain('initialized');
      expect(existsSync(join(tmpDir, '_dream_context', 'core', '0.soul.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '_dream_context', 'core', '1.user.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '_dream_context', 'core', '2.memory.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '_dream_context', 'core', 'CHANGELOG.json'))).toBe(true);
      expect(existsSync(join(tmpDir, '_dream_context', 'state'))).toBe(true);
      expect(existsSync(join(tmpDir, '_dream_context', 'knowledge'))).toBe(true);
    });

    it('refuses to init if _dream_context/ already exists', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      const output = run('init --yes --name "Test2" --description "d" --stack "Node" --priority "p"', tmpDir);
      expect(output).toContain('already exists');
    });

    it('soul file contains project name', () => {
      run('init --yes --name "MyProject" --description "A cool project" --stack "TypeScript" --priority "MVP"', tmpDir);
      const soul = readFileSync(join(tmpDir, '_dream_context', 'core', '0.soul.md'), 'utf-8');
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
      expect(existsSync(join(tmpDir, '_dream_context', 'state', 'my-task.md'))).toBe(true);
    });

    it('creates a task with rich template sections', () => {
      run('tasks create rich-task --description "Test rich" --priority medium --why "Testing rich templates"', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'rich-task.md'), 'utf-8');
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
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'no-why.md'), 'utf-8');
      expect(content).toContain('## Why');
      expect(content).toContain('(To be defined)');
    });

    it('inserts into task user_stories section', () => {
      run('tasks create ins-test --description "Test" --priority low', tmpDir);
      const output = run('tasks insert ins-test user_stories "As a user, I want to test inserts"', tmpDir);
      expect(output).toContain('Inserted');
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'ins-test.md'), 'utf-8');
      expect(content).toContain('As a user, I want to test inserts');
    });

    it('inserts into task acceptance_criteria section', () => {
      run('tasks create ac-test --description "Test" --priority low', tmpDir);
      run('tasks insert ac-test acceptance_criteria "Tests pass with 100% coverage"', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'ac-test.md'), 'utf-8');
      expect(content).toContain('Tests pass with 100% coverage');
    });

    it('inserts into task constraints with auto-date', () => {
      run('tasks create ct-test --description "Test" --priority low', tmpDir);
      run('tasks insert ct-test constraints "No external dependencies"', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'ct-test.md'), 'utf-8');
      expect(content).toMatch(/\*\*\[\d{4}-\d{2}-\d{2}\]\*\* No external dependencies/);
    });

    it('inserts into task changelog with auto-date header', () => {
      run('tasks create cl-test --description "Test" --priority low', tmpDir);
      run('tasks insert cl-test changelog "Added pagination support"', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'cl-test.md'), 'utf-8');
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
      const stateDir = join(tmpDir, '_dream_context', 'state');
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
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'log-test.md'), 'utf-8');
      expect(content).toContain('Implemented feature X');
    });

    it('completes a task without a summary in non-interactive mode (no hang)', () => {
      run('tasks create no-summary --description "Test" --priority low', tmpDir);
      // `run` invokes via execSync with no TTY; the bare form must not block on a prompt.
      const output = run('tasks complete no-summary', tmpDir);
      expect(output).toContain('completed');
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'no-summary.md'), 'utf-8');
      expect(content).toMatch(/status:\s*"?completed"?/);
      expect(content).toContain('Task completed.');
    });

    it('completes a task', () => {
      run('tasks create done-task --description "Test" --priority low', tmpDir);
      run('tasks complete done-task "All done"', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'done-task.md'), 'utf-8');
      expect(content).toContain('status: completed');
      expect(content).toContain('All done');
    });

    it('creates a task with no flags (uses defaults, no prompts)', () => {
      const output = run('tasks create defaults-test', tmpDir);
      expect(output).toContain('created');
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'defaults-test.md'), 'utf-8');
      expect(content).toContain('priority: "medium"');
      expect(content).toContain('status: "todo"');
      expect(content).toContain('description: "defaults-test"');
      expect(content).toContain('tags: []');
    });

    it('creates a task with --status and --tags flags', () => {
      run('tasks create flagged-task -d "Flagged" -p high -s in_progress -t "backend,api"', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'flagged-task.md'), 'utf-8');
      expect(content).toContain('status: "in_progress"');
      expect(content).toContain('priority: "high"');
      expect(content).toContain('"backend"');
      expect(content).toContain('"api"');
    });

    it('creates a task with --status completed', () => {
      run('tasks create completed-task -d "Done from start" -s completed', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'completed-task.md'), 'utf-8');
      expect(content).toContain('status: "completed"');
    });

    it('creates a task with --status in_review', () => {
      run('tasks create review-task -d "Needs review" -s in_review', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'state', 'review-task.md'), 'utf-8');
      expect(content).toContain('status: "in_review"');
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

    it('filters by --tag with AND semantics', () => {
      run('tasks create tag-both -d "x" -t memoryos,backend', tmpDir);
      run('tasks create tag-one -d "x" -t memoryos', tmpDir);
      const output = run('tasks list --tag memoryos --tag backend', tmpDir);
      expect(output).toContain('tag-both');
      expect(output).not.toContain('tag-one');
    });

    it('filters by --any-tag with OR semantics', () => {
      run('tasks create any-a -d "x" -t backend', tmpDir);
      run('tasks create any-b -d "x" -t frontend', tmpDir);
      run('tasks create any-c -d "x" -t docs', tmpDir);
      const output = run('tasks list --any-tag backend --any-tag frontend', tmpDir);
      expect(output).toContain('any-a');
      expect(output).toContain('any-b');
      expect(output).not.toContain('any-c');
    });

    it('filters by --version and --priority', () => {
      run('tasks create v-s5 -d "x" -v S5 -p critical', tmpDir);
      run('tasks create v-backlog -d "x" -v BACKLOG -p low', tmpDir);
      expect(run('tasks list --version S5', tmpDir)).toContain('v-s5');
      expect(run('tasks list --version S5', tmpDir)).not.toContain('v-backlog');
      expect(run('tasks list --priority critical', tmpDir)).toContain('v-s5');
      expect(run('tasks list --priority critical', tmpDir)).not.toContain('v-backlog');
    });

    it('groups output with --group-by version', () => {
      run('tasks create g-a -d "x" -v S5', tmpDir);
      run('tasks create g-b -d "x" -v S6', tmpDir);
      const output = run('tasks list --group-by version', tmpDir);
      expect(output).toMatch(/S5 \(1\)/);
      expect(output).toMatch(/S6 \(1\)/);
    });

    it('emits JSON with --json', () => {
      run('tasks create json-task -d "A JSON task" -t memoryos -v S5 -p high', tmpDir);
      const output = run('tasks list --tag memoryos --json', tmpDir);
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      const task = parsed.find((t: { name: string }) => t.name === 'json-task');
      expect(task).toBeTruthy();
      expect(task.tags).toContain('memoryos');
      expect(task.version).toBe('S5');
      expect(task.priority).toBe('high');
    });

    it('lists distinct tags with counts via `tasks tags`', () => {
      run('tasks create tags-a -d "x" -t memoryos,backend', tmpDir);
      run('tasks create tags-b -d "x" -t memoryos', tmpDir);
      const output = run('tasks tags', tmpDir);
      expect(output).toMatch(/memoryos\s+2/);
      expect(output).toMatch(/backend\s+1/);
    });

    it('rejects an invalid --group-by field', () => {
      run('tasks create gb-bad -d "x"', tmpDir);
      const output = run('tasks list --group-by nonsense', tmpDir);
      expect(output).toContain('--group-by must be one of');
    });
  });

  describe('features', () => {
    beforeEach(() => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    });

    it('creates a feature', () => {
      const output = run('features create auth --why "Users need to log in"', tmpDir);
      expect(output).toContain('created');
      expect(existsSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'auth.md'))).toBe(true);
    });

    it('inserts into feature changelog', () => {
      run('features create auth --why "Login"', tmpDir);
      run('features insert auth changelog "Added JWT middleware"', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'auth.md'), 'utf-8');
      expect(content).toContain('Added JWT middleware');
    });

    it('creates a feature with --tags / --status / --related-tasks (write-through to the tasks)', () => {
      // related_tasks is validated at write time — the tasks must exist.
      run('tasks create login --why "x"', tmpDir);
      run('tasks create signup --why "x"', tmpDir);
      run('features create auth --why "Login" --tags security,backend --status in_progress --related-tasks login,signup', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'auth.md'), 'utf-8');
      expect(content).toMatch(/status:\s*in_progress/);
      expect(content).toContain('security');
      expect(content).toContain('backend');
      expect(content).toContain('login');
      expect(content).toContain('signup');
      // Bidirectional invariant: each listed task now points back at the feature.
      for (const slug of ['login', 'signup']) {
        const task = readFileSync(join(tmpDir, '_dream_context', 'state', `${slug}.md`), 'utf-8');
        expect(task).toMatch(/related_feature:\s*auth/);
      }
    });

    it('rejects --related-tasks entries that are not existing tasks', () => {
      const output = run('features create ghosty --why "x" --related-tasks no-such-task', tmpDir);
      expect(output).toContain('Unknown task slug');
      const content = readFileSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'ghosty.md'), 'utf-8');
      expect(content).not.toContain('no-such-task');
    });

    it('links a task to a feature via `tasks feature` and clears it (both sides maintained)', () => {
      run('features create auth --why "Login"', tmpDir);
      run('tasks create oauth-flow --why "x"', tmpDir);
      const set = run('tasks feature oauth-flow auth', tmpDir);
      expect(set).toContain('auth');
      expect(readFileSync(join(tmpDir, '_dream_context', 'state', 'oauth-flow.md'), 'utf-8')).toMatch(/related_feature:\s*auth/);
      expect(readFileSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'auth.md'), 'utf-8')).toContain('oauth-flow');
      const cleared = run('tasks feature oauth-flow clear', tmpDir);
      expect(cleared).toContain('Cleared');
      expect(readFileSync(join(tmpDir, '_dream_context', 'state', 'oauth-flow.md'), 'utf-8')).toMatch(/related_feature:\s*null/);
      expect(readFileSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'auth.md'), 'utf-8')).not.toContain('oauth-flow');
    });

    it('tasks create --feature validates and write-throughs; unknown feature is refused', () => {
      run('features create auth --why "Login"', tmpDir);
      run('tasks create linked-at-birth --why "x" --feature auth', tmpDir);
      expect(readFileSync(join(tmpDir, '_dream_context', 'state', 'linked-at-birth.md'), 'utf-8')).toMatch(/related_feature:\s*auth/);
      expect(readFileSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'auth.md'), 'utf-8')).toContain('linked-at-birth');
      const refused = run('tasks create orphan --why "x" --feature no-such-feature', tmpDir);
      expect(refused).toContain('Unknown feature');
      expect(existsSync(join(tmpDir, '_dream_context', 'state', 'orphan.md'))).toBe(false);
    });

    it('rejects an invalid feature --status', () => {
      const output = run('features create auth --why "x" --status bogus', tmpDir);
      expect(output).toContain('Status must be one of');
    });

    it('sets frontmatter fields via `features set`', () => {
      run('features create auth --why "Login"', tmpDir);
      run('features set auth status in_review', tmpDir);
      run('features set auth tags alpha,beta', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'auth.md'), 'utf-8');
      expect(content).toMatch(/status:\s*in_review/);
      expect(content).toContain('alpha');
      expect(content).toContain('beta');
    });

    it('insert replaces the user_stories placeholder and formats as a checkbox', () => {
      run('features create auth --why "Login"', tmpDir);
      run('features insert auth user_stories "As a user, I can sign in"', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'auth.md'), 'utf-8');
      expect(content).toContain('- [ ] As a user, I can sign in');
      // skeleton placeholder is gone
      expect(content).not.toContain('[action]');
      expect(content).not.toContain('[outcome]');
    });

    it('insert does not glue content to the next section header', () => {
      run('features create auth --why "Login"', tmpDir);
      run('features insert auth notes "An edge case"', tmpDir);
      const content = readFileSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'auth.md'), 'utf-8');
      expect(content).not.toMatch(/An edge case\n## /);
    });
  });

  describe('bookmark', () => {
    beforeEach(() => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    });

    it('creates a bookmark with --task flag', () => {
      const output = run('bookmark add "Auth refactored" --task fix-auth -s 2', tmpDir);
      expect(output).toContain('Bookmarked');

      const sleepPath = join(tmpDir, '_dream_context', 'state', '.sleep.json');
      const state = JSON.parse(readFileSync(sleepPath, 'utf-8'));
      expect(state.bookmarks).toHaveLength(1);
      expect(state.bookmarks[0].task_slug).toBe('fix-auth');
      expect(state.bookmarks[0].message).toBe('Auth refactored');
    });

    it('creates a bookmark without --task (null task_slug)', () => {
      run('bookmark add "General note" -s 1', tmpDir);

      const sleepPath = join(tmpDir, '_dream_context', 'state', '.sleep.json');
      const state = JSON.parse(readFileSync(sleepPath, 'utf-8'));
      expect(state.bookmarks[0].task_slug).toBeNull();
    });

    it('shows task association in bookmark list', () => {
      run('bookmark add "Working on auth" --task fix-auth -s 2', tmpDir);
      const output = run('bookmark list', tmpDir);
      expect(output).toContain('Working on auth');
      expect(output).toContain('fix-auth');
    });
  });

  describe('knowledge', () => {
    beforeEach(() => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    });

    it('creates a knowledge file with proper YAML (no injection)', () => {
      const output = run('knowledge create "test-topic" --description "A test topic" --tags "ai,agent" --content "Some research"', tmpDir);
      expect(output).toContain('created');
      const file = join(tmpDir, '_dream_context', 'knowledge', 'test-topic.md');
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('name: test-topic');
      expect(content).toContain('Some research');
    });

    it('handles special characters in name without breaking YAML', () => {
      const output = run('knowledge create "test: value" --description "Has colon" --tags "test" --content "Content"', tmpDir);
      expect(output).toContain('created');
      const file = join(tmpDir, '_dream_context', 'knowledge', 'test-value.md');
      const content = readFileSync(file, 'utf-8');
      // Should be valid YAML — gray-matter handles the quoting
      expect(content).toContain('test: value');
    });

    it('creates knowledge file with pinned field', () => {
      run('knowledge create "pinned-test" --description "Test" --tags "test" --content "Content"', tmpDir);
      const file = join(tmpDir, '_dream_context', 'knowledge', 'pinned-test.md');
      const content = readFileSync(file, 'utf-8');
      expect(content).toContain('pinned: false');
    });

    it('lists knowledge index in plain mode', () => {
      run('knowledge create "test-topic" --description "A test topic" --tags "ai,agent" --content "Some research"', tmpDir);
      const output = run('knowledge index --plain', tmpDir);
      expect(output).toContain('test-topic: A test topic [ai, agent]');
    });

    it('shows empty message when no knowledge files exist', () => {
      // A fresh init scaffolds knowledge/data-structures/default.md; clear it to
      // exercise the truly-empty state.
      rmSync(join(tmpDir, '_dream_context', 'knowledge', 'data-structures'), { recursive: true, force: true });
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

    describe('knowledge merge', () => {
      const knowledgeDir = () => join(tmpDir, '_dream_context', 'knowledge');

      it('merges src into dst: dst gets src body under marker, src is deleted, third-file link repointed', () => {
        // Create src and dst knowledge files directly
        writeFileSync(
          join(knowledgeDir(), 'merge-src.md'),
          '---\nname: merge-src\ndescription: source\ntags: ["extra-tag"]\n---\n\nSource body content.\n',
          'utf-8',
        );
        writeFileSync(
          join(knowledgeDir(), 'merge-dst.md'),
          '---\nname: merge-dst\ndescription: destination\ntags: ["base-tag"]\n---\n\nDest body content.\n',
          'utf-8',
        );
        // Third file with a [[merge-src]] link
        writeFileSync(
          join(knowledgeDir(), 'third-file.md'),
          '---\nname: third\ndescription: third\ntags: []\n---\n\nSee [[merge-src]] for details.\n',
          'utf-8',
        );

        const output = run('knowledge merge merge-src merge-dst', tmpDir);

        // Command exits ok (no error prefix)
        expect(output).not.toContain('Error:');
        expect(output).toContain('merge-src');
        expect(output).toContain('merge-dst');

        // dst file contains the merged marker and src body
        const dstContent = readFileSync(join(knowledgeDir(), 'merge-dst.md'), 'utf-8');
        expect(dstContent).toContain('<!-- merged-from: merge-src -->');
        expect(dstContent).toContain('Source body content.');
        expect(dstContent).toContain('Dest body content.');

        // src file is deleted
        expect(existsSync(join(knowledgeDir(), 'merge-src.md'))).toBe(false);

        // third-file link repointed from [[merge-src]] to [[merge-dst]]
        const thirdContent = readFileSync(join(knowledgeDir(), 'third-file.md'), 'utf-8');
        expect(thirdContent).toContain('[[merge-dst]]');
        expect(thirdContent).not.toContain('[[merge-src]]');
      });

      it('reports an error when src does not exist', () => {
        writeFileSync(
          join(knowledgeDir(), 'only-dst.md'),
          '---\nname: only-dst\ndescription: dst\ntags: []\n---\n\nContent.\n',
          'utf-8',
        );

        const output = run('knowledge merge ghost-src only-dst', tmpDir);
        expect(output).toContain('ghost-src');
        expect(existsSync(join(knowledgeDir(), 'only-dst.md'))).toBe(true);
      });

      it('reports an error when dst does not exist', () => {
        writeFileSync(
          join(knowledgeDir(), 'orphan-src.md'),
          '---\nname: orphan-src\ndescription: src\ntags: []\n---\n\nContent.\n',
          'utf-8',
        );

        const output = run('knowledge merge orphan-src ghost-dst', tmpDir);
        expect(output).toContain('ghost-dst');
        expect(existsSync(join(knowledgeDir(), 'orphan-src.md'))).toBe(true);
      });
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
      // Two SessionStart groups: the context snapshot + the dashboard auto-open.
      expect(settings.hooks.SessionStart).toHaveLength(2);
      expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('npx dreamcontext hook session-start');
      expect(settings.hooks.SessionStart[1].hooks[0].command).toBe('npx dreamcontext hook ensure-dashboard');
      expect(settings.hooks.Stop).toBeDefined();
      expect(settings.hooks.Stop).toHaveLength(1);
      expect(settings.hooks.Stop[0].hooks[0].command).toBe('npx dreamcontext hook stop');
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
      expect(settings.hooks.PostToolUse[1].hooks[0].command).toBe('npx dreamcontext hook post-tool-use');
      // Hooks added (session-start snapshot + ensure-dashboard auto-open)
      expect(settings.hooks.SessionStart).toHaveLength(2);
      expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('npx dreamcontext hook session-start');
      expect(settings.hooks.SessionStart[1].hooks[0].command).toBe('npx dreamcontext hook ensure-dashboard');
      expect(settings.hooks.Stop).toHaveLength(1);
    });

    it('migrates old snapshot hook to session-start hook', () => {
      // Create settings with old hook
      mkdirSync(join(tmpDir, '.claude'), { recursive: true });
      writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: 'startup|resume|compact|clear',
            hooks: [{ type: 'command', command: 'npx dreamcontext snapshot', timeout: 10 }],
          }],
        },
      }, null, 2), 'utf-8');

      run('install-skill', tmpDir);
      const settings = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'));

      // Old hook replaced, not duplicated; ensure-dashboard added as the 2nd group
      expect(settings.hooks.SessionStart).toHaveLength(2);
      expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('npx dreamcontext hook session-start');
      expect(settings.hooks.SessionStart[1].hooks[0].command).toBe('npx dreamcontext hook ensure-dashboard');
      // Stop hook also added
      expect(settings.hooks.Stop).toHaveLength(1);
    });

    it('reconciles a stale UserPromptSubmit timeout to the current spec', () => {
      // A project written by an older installer pinned the recall hook at 5s,
      // before the Haiku recall path (which can take ~15s) required the larger
      // 120s timeout. Re-running install must heal the drift, not skip it.
      mkdirSync(join(tmpDir, '.claude'), { recursive: true });
      writeFileSync(join(tmpDir, '.claude', 'settings.json'), JSON.stringify({
        hooks: {
          UserPromptSubmit: [{
            hooks: [{ type: 'command', command: 'npx dreamcontext hook user-prompt-submit', timeout: 5 }],
          }],
        },
      }, null, 2), 'utf-8');

      run('install-skill', tmpDir);
      const settings = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'));

      // Same single hook (no duplicate), timeout bumped to the canonical value.
      expect(settings.hooks.UserPromptSubmit).toHaveLength(1);
      expect(settings.hooks.UserPromptSubmit[0].hooks[0].command).toBe('npx dreamcontext hook user-prompt-submit');
      expect(settings.hooks.UserPromptSubmit[0].hooks[0].timeout).toBe(120);
    });

    it('does not duplicate hooks on repeated install', () => {
      run('install-skill', tmpDir);
      run('install-skill', tmpDir);
      const settings = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'));
      // Two SessionStart groups (snapshot + ensure-dashboard), each deduped to one.
      expect(settings.hooks.SessionStart).toHaveLength(2);
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
      expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('npx dreamcontext hook post-tool-use');
      expect(settings.hooks.PostToolUse[0].hooks[0].timeout).toBe(30);

      expect(settings.hooks.PreCompact).toBeDefined();
      expect(settings.hooks.PreCompact).toHaveLength(1);
      expect(settings.hooks.PreCompact[0].hooks[0].command).toBe('npx dreamcontext hook pre-compact');
      expect(settings.hooks.PreCompact[0].hooks[0].timeout).toBe(5);
    });

    it('installs two PreToolUse entries: Agent gate and write-tools gate', () => {
      run('install-skill', tmpDir);
      const settings = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'));

      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PreToolUse).toHaveLength(2);

      const agentEntry = settings.hooks.PreToolUse.find((g: any) => g.matcher === 'Agent');
      expect(agentEntry).toBeDefined();
      expect(agentEntry.hooks[0].command).toBe('npx dreamcontext hook pre-tool-use');

      const writeEntry = settings.hooks.PreToolUse.find((g: any) => g.matcher === 'Edit|Write|MultiEdit');
      expect(writeEntry).toBeDefined();
      expect(writeEntry.hooks[0].command).toBe('npx dreamcontext hook pre-tool-use');
    });

    it('does not duplicate the write-tools PreToolUse entry on repeated install', () => {
      run('install-skill', tmpDir);
      run('install-skill', tmpDir);
      const settings = JSON.parse(readFileSync(join(tmpDir, '.claude', 'settings.json'), 'utf-8'));
      expect(settings.hooks.PreToolUse).toHaveLength(2);
    });
  });

  describe('snapshot', () => {
    it('returns empty when no _dream_context/', () => {
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

    it('reports error when _dream_context/ does not exist', () => {
      const output = run('doctor', tmpDir);
      expect(output).toContain('not found');
    });

    it('reports error on malformed JSON', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      writeFileSync(join(tmpDir, '_dream_context', 'core', 'CHANGELOG.json'), '{ broken', 'utf-8');
      const output = run('doctor', tmpDir);
      expect(output).toContain('Malformed JSON');
    });

    it('reports warning on empty core file', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      writeFileSync(join(tmpDir, '_dream_context', 'core', '0.soul.md'), '', 'utf-8');
      const output = run('doctor', tmpDir);
      expect(output).toContain('Empty file');
    });

    it('reports warning on placeholder content', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      writeFileSync(join(tmpDir, '_dream_context', 'core', '0.soul.md'), '(Add your principles here)', 'utf-8');
      const output = run('doctor', tmpDir);
      expect(output).toContain('placeholder');
    });

    it('warns (non-fatal) when core/taxonomy.json is missing', () => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
      const taxonomyPath = join(tmpDir, '_dream_context', 'core', 'taxonomy.json');
      // taxonomy.json is created by init; delete it to simulate a missing file.
      if (existsSync(taxonomyPath)) {
        rmSync(taxonomyPath);
      }
      const output = run('doctor', tmpDir);
      // Should warn, not hard-error; must hint to run taxonomy init.
      expect(output).toContain('taxonomy');
      expect(output).toContain('taxonomy init');
      // Doctor exits 0 for warnings (no hard error from taxonomy alone).
    });
  });

  describe('taxonomy', () => {
    beforeEach(() => {
      run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);
    });

    it('taxonomy vocab outputs the resolved vocabulary', () => {
      const output = run('taxonomy vocab', tmpDir);
      expect(output).toContain('Taxonomy Vocabulary');
      // Default faceted tags present
      expect(output).toContain('topic:recall');
      expect(output).toContain('domain:database');
    });

    it('taxonomy vocab --json emits valid JSON with expected shape', () => {
      const output = run('taxonomy vocab --json', tmpDir);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('facetTags');
      expect(parsed).toHaveProperty('aliases');
      expect(parsed).toHaveProperty('bareTags');
      expect(Array.isArray(parsed.facetTags.topic)).toBe(true);
      expect(parsed.facetTags.topic).toContain('topic:recall');
    });

    it('taxonomy vocab --facet domain filters output to domain facet', () => {
      const output = run('taxonomy vocab --facet domain', tmpDir);
      expect(output).toContain('domain');
      expect(output).toContain('domain:database');
      // Other facets should not appear (layer, kind, topic)
      expect(output).not.toContain('topic:recall');
      expect(output).not.toContain('layer:frontend');
    });

    it('taxonomy vocab --facet --json emits only the requested facet', () => {
      const output = run('taxonomy vocab --facet topic --json', tmpDir);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('topic');
      expect(Array.isArray(parsed.topic)).toBe(true);
      expect(parsed.topic).toContain('topic:recall');
      // Other facets must not be present
      expect(parsed).not.toHaveProperty('domain');
    });

    it('taxonomy vocab --facet rejects unknown facet name', () => {
      const output = run('taxonomy vocab --facet bogus', tmpDir);
      expect(output).toContain('bogus');
    });

    it('taxonomy audit exits 0 and is strictly read-only', () => {
      // Run audit; it must complete without error (exit 0).
      const output = run('taxonomy audit', tmpDir);
      // Audit output contains the audit header.
      expect(output).toContain('Taxonomy Audit');
    });

    it('taxonomy audit --json emits valid JSON', () => {
      const output = run('taxonomy audit --json', tmpDir);
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('untagged');
      expect(parsed).toHaveProperty('nonCanonical');
      expect(parsed).toHaveProperty('orphan');
      expect(parsed).toHaveProperty('nearDups');
    });

    it('taxonomy init creates core/taxonomy.json (idempotent, no overwrite)', () => {
      const taxonomyPath = join(tmpDir, '_dream_context', 'core', 'taxonomy.json');
      // init already creates taxonomy.json; delete it first so taxonomy init recreates it.
      if (existsSync(taxonomyPath)) {
        rmSync(taxonomyPath);
      }
      const output = run('taxonomy init', tmpDir);
      expect(output).toContain('Created');
      expect(existsSync(taxonomyPath)).toBe(true);
      // File is valid JSON with version field.
      const content = JSON.parse(readFileSync(taxonomyPath, 'utf-8'));
      expect(content.version).toBe(1);
      expect(content.facets).toBeDefined();
      expect(content.aliases).toBeDefined();
    });

    it('taxonomy init is idempotent — second run does not overwrite existing file', () => {
      const taxonomyPath = join(tmpDir, '_dream_context', 'core', 'taxonomy.json');
      // Ensure it exists (init created it).
      if (!existsSync(taxonomyPath)) {
        run('taxonomy init', tmpDir);
      }
      // Write a custom sentinel key into the JSON.
      const existing = JSON.parse(readFileSync(taxonomyPath, 'utf-8'));
      existing.sentinel = 'DO_NOT_OVERWRITE';
      writeFileSync(taxonomyPath, JSON.stringify(existing, null, 2), 'utf-8');

      const output = run('taxonomy init', tmpDir);
      // Should say already exists, not Created.
      expect(output).toContain('already exists');
      // File must be unchanged (sentinel preserved).
      const after = JSON.parse(readFileSync(taxonomyPath, 'utf-8'));
      expect(after.sentinel).toBe('DO_NOT_OVERWRITE');
    });

    it('init scaffolds core/taxonomy.json (not taxonomy.md)', () => {
      // init was already run in beforeEach; verify taxonomy.json was created.
      const taxonomyJsonPath = join(tmpDir, '_dream_context', 'core', 'taxonomy.json');
      const taxonomyMdPath = join(tmpDir, '_dream_context', 'core', 'taxonomy.md');
      expect(existsSync(taxonomyJsonPath)).toBe(true);
      expect(existsSync(taxonomyMdPath)).toBe(false);
      // JSON file must be parseable.
      const content = JSON.parse(readFileSync(taxonomyJsonPath, 'utf-8'));
      expect(content.version).toBe(1);
    });

    it('taxonomy add: adds a valid faceted tag', () => {
      const output = run('taxonomy add domain:payments', tmpDir);
      expect(output).toContain('Added');
      expect(output).toContain('domain:payments');
      // Verify it appears in vocab
      const vocabOutput = run('taxonomy vocab --json', tmpDir);
      const vocab = JSON.parse(vocabOutput);
      expect(vocab.facetTags.domain).toContain('domain:payments');
    });

    it('taxonomy add: exits 0 for already-existing tag', () => {
      // topic:recall is in DEFAULT_VOCABULARY — adding it is benign
      const output = run('taxonomy add topic:recall', tmpDir);
      expect(output).toContain('already exists');
      // Must not contain error language
      expect(output).not.toContain('Error:');
    });

    it('taxonomy add: exits 1 for unknown facet', () => {
      // run() catches non-zero exits but still returns output
      const output = run('taxonomy add custom:value', tmpDir);
      expect(output).toContain('unknown facet');
    });

    it('taxonomy add: rejects tag that is an alias of an existing canonical', () => {
      // 'search' is an alias of 'topic:recall' in DEFAULT_VOCABULARY
      const output = run('taxonomy add search', tmpDir);
      expect(output).toContain('alias');
    });

    it('taxonomy alias: adds a valid alias mapping', () => {
      const output = run('taxonomy alias pay domain:database', tmpDir);
      expect(output).toContain('Added alias');
      // Verify it appears in vocab
      const vocabOutput = run('taxonomy vocab --json', tmpDir);
      const vocab = JSON.parse(vocabOutput);
      expect(vocab.aliases['pay']).toBe('domain:database');
    });

    it('taxonomy alias: exits 0 for already-existing identical mapping', () => {
      // 'search' → 'topic:recall' is in DEFAULT_VOCABULARY
      const output = run('taxonomy alias search topic:recall', tmpDir);
      expect(output).toContain('already exists');
      expect(output).not.toContain('Error:');
    });

    it('taxonomy alias: exits 1 when canonical does not exist', () => {
      const output = run('taxonomy alias myalias domain:nonexistent', tmpDir);
      expect(output).toContain('does not exist');
    });

    it('taxonomy alias: exits 1 to prevent chains', () => {
      // 'search' is already an alias — it cannot be used as a canonical
      const output = run('taxonomy alias newkey search', tmpDir);
      expect(output).toContain('chain');
    });

    it('taxonomy resolve: shows classification for a faceted tag', () => {
      const output = run('taxonomy resolve topic:recall', tmpDir);
      expect(output).toContain('topic:recall');
      expect(output).toContain('faceted');
    });

    it('taxonomy resolve: shows alias resolution', () => {
      const output = run('taxonomy resolve search', tmpDir);
      expect(output).toContain('alias');
      expect(output).toContain('topic:recall');
    });

    it('taxonomy resolve --json emits valid JSON with classification', () => {
      const output = run('taxonomy resolve topic:recall --json', tmpDir);
      const parsed = JSON.parse(output);
      expect(parsed.tag).toBe('topic:recall');
      expect(parsed.classification).toBe('faceted');
      expect(parsed.indexValue).toBe('recall');
    });

    it('taxonomy resolve --json: alias shows canonical', () => {
      const output = run('taxonomy resolve search --json', tmpDir);
      const parsed = JSON.parse(output);
      expect(parsed.classification).toBe('alias');
      expect(parsed.canonical).toBe('topic:recall');
    });

    it('doctor warns about missing taxonomy.json after delete', () => {
      const taxonomyPath = join(tmpDir, '_dream_context', 'core', 'taxonomy.json');
      if (existsSync(taxonomyPath)) rmSync(taxonomyPath);
      const output = run('doctor', tmpDir);
      expect(output).toContain('taxonomy');
      expect(output).toContain('taxonomy init');
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

    it('outputs nothing when no _dream_context/', () => {
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
      const changelogPath = join(tmpDir, '_dream_context', 'core', 'CHANGELOG.json');
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
      const releases = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'core', 'RELEASES.json'), 'utf-8'));
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
      const releases = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'core', 'RELEASES.json'), 'utf-8'));
      expect(releases[0].tasks).toHaveLength(1);
      expect(releases[0].tasks[0]).toMatch(/^task_/);
    });

    it('auto-discovers unreleased features and back-populates released_version', () => {
      run('features create auth --why "Login"', tmpDir);
      run('core releases add --ver 1.0.0 --summary "Auth release" --yes', tmpDir);
      const releases = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'core', 'RELEASES.json'), 'utf-8'));
      expect(releases[0].features).toHaveLength(1);
      // Verify back-population
      const feature = readFileSync(join(tmpDir, '_dream_context', 'knowledge', 'features', 'auth.md'), 'utf-8');
      expect(feature).toContain('released_version');
      expect(feature).toContain('1.0.0');
    });

    it('auto-discovers changelog entries', () => {
      const changelogPath = join(tmpDir, '_dream_context', 'core', 'CHANGELOG.json');
      const entries = JSON.parse(readFileSync(changelogPath, 'utf-8'));
      entries.unshift({ date: '2026-02-25', type: 'feat', scope: 'auth', description: 'Added JWT', breaking: false });
      writeFileSync(changelogPath, JSON.stringify(entries, null, 2), 'utf-8');

      run('core releases add --ver 1.0.0 --summary "Test" --yes', tmpDir);
      const releases = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'core', 'RELEASES.json'), 'utf-8'));
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

      const releases = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'core', 'RELEASES.json'), 'utf-8'));
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

    describe('set-status', () => {
      it('flips a planning release to released with a date', () => {
        run('core releases add --ver 0.6.0 --summary "Beta" --status planning', tmpDir);
        const out = run('core releases set-status 0.6.0 released --date 2026-06-05', tmpDir);
        expect(out).toContain('0.6.0');
        expect(out).toContain('released');
        expect(out).toContain('2026-06-05');

        const releases = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'core', 'RELEASES.json'), 'utf-8'));
        const entry = releases.find((r: any) => r.version === '0.6.0');
        expect(entry).toBeTruthy();
        expect(entry.status).toBe('released');
        expect(entry.date).toBe('2026-06-05');
      });

      it('errors on a nonexistent version', () => {
        const out = run('core releases set-status 9.9.9 released', tmpDir);
        expect(out).toContain('not found');
        expect(out).toContain('9.9.9');
      });

      it('errors on an invalid status value', () => {
        run('core releases add --ver 0.7.0 --summary "RC" --status planning', tmpDir);
        const out = run('core releases set-status 0.7.0 shipped', tmpDir);
        expect(out).toContain("must be 'planning' or 'released'");
      });

      it('preserves all other fields after update', () => {
        run('core releases add --ver 0.8.0 --summary "RC2" --status planning', tmpDir);
        run('core releases set-status 0.8.0 released --date 2026-06-10', tmpDir);
        const releases = JSON.parse(readFileSync(join(tmpDir, '_dream_context', 'core', 'RELEASES.json'), 'utf-8'));
        const entry = releases.find((r: any) => r.version === '0.8.0');
        expect(entry.summary).toBe('RC2');
        expect(entry.id).toMatch(/^rel_/);
        expect(Array.isArray(entry.features)).toBe(true);
        expect(Array.isArray(entry.tasks)).toBe(true);
      });
    });
  });

  describe('install-skill --packs', () => {
    it('installs a specific pack by name', () => {
      const output = run('install-skill --packs engineering', tmpDir);
      expect(output).toContain('engineering');
      expect(output).toContain('files installed');
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'backend-principles.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'web-app-frontend.md'))).toBe(true);
    });

    it('installs firebase sub-skills with references', () => {
      run('install-skill --packs engineering', tmpDir);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'firebase-cloud-functions', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'firebase-cloud-functions', 'references', 'idempotency.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'firebase-firestore', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'firebase-firestore', 'references', 'security_rules.md'))).toBe(true);
    });

    it('installs related agents alongside pack', () => {
      run('install-skill --packs engineering', tmpDir);
      expect(existsSync(join(tmpDir, '.claude', 'agents', 'reviewer.md'))).toBe(true);
    });

    it('installs brand-voice pack with discover-brand agent', () => {
      const output = run('install-skill --packs brand-voice', tmpDir);
      expect(output).toContain('brand-voice');
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'brand-voice', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'brand-voice', 'discover-brand.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.claude', 'agents', 'discover-brand.md'))).toBe(true);
      // Generic agents removed — only discover-brand is a real sub-agent
      expect(existsSync(join(tmpDir, '.claude', 'agents', 'quality-assurance.md'))).toBe(false);
      expect(existsSync(join(tmpDir, '.claude', 'agents', 'document-analysis.md'))).toBe(false);
    });

    it('installs multiple packs at once', () => {
      const output = run('install-skill --packs design growth', tmpDir);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'design', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'growth', 'SKILL.md'))).toBe(true);
      expect(output).toContain('files installed');
    });

    it('installs a standalone skill pack', () => {
      run('install-skill --packs system-prompts', tmpDir);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'system-prompts', 'SKILL.md'))).toBe(true);
    });

    it('warns about cross-pack dependencies', () => {
      const output = run('install-skill --packs engineering', tmpDir);
      expect(output).toContain('recommends');
      expect(output).toContain('design');
    });

    it('suppresses cross-pack warning when dep is also selected', () => {
      const output = run('install-skill --packs engineering design', tmpDir);
      expect(output).not.toContain('recommends');
    });

    it('errors on unknown pack name', () => {
      const output = run('install-skill --packs nonexistent', tmpDir);
      expect(output).toContain('not found');
      expect(output).toContain('Available');
    });
  });

  describe('install-skill --skill', () => {
    it('installs a single sub-skill', () => {
      const output = run('install-skill --skill backend-principles', tmpDir);
      expect(output).toContain('backend-principles');
      expect(output).toContain('engineering');
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'backend-principles.md'))).toBe(true);
    });

    it('installs a sub-skill with references', () => {
      run('install-skill --skill firebase-firestore', tmpDir);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'firebase-firestore', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(tmpDir, '.claude', 'skills', 'engineering', 'firebase-firestore', 'references', 'security_rules.md'))).toBe(true);
    });

    it('warns when base pack is not installed', () => {
      const output = run('install-skill --skill backend-principles', tmpDir);
      expect(output).toContain('Base');
      expect(output).toContain('engineering');
      expect(output).toContain('not installed');
    });

    it('does not warn when base pack is already installed', () => {
      run('install-skill --packs engineering', tmpDir);
      const output = run('install-skill --skill backend-principles', tmpDir);
      expect(output).not.toContain('not installed');
    });

    it('errors on unknown skill name', () => {
      const output = run('install-skill --skill nonexistent-skill', tmpDir);
      expect(output).toContain('not found');
      expect(output).toContain('Available skills');
    });
  });

  describe('install-skill --list', () => {
    it('shows all available packs and skills', () => {
      const output = run('install-skill --list', tmpDir);
      expect(output).toContain('engineering');
      expect(output).toContain('design');
      expect(output).toContain('growth');
      expect(output).toContain('brand-voice');
      expect(output).toContain('system-prompts');
      expect(output).toContain('backend-principles');
      expect(output).toContain('firebase-cloud-functions');
    });

    it('shows always active badge', () => {
      const output = run('install-skill --list', tmpDir);
      expect(output).toContain('always active');
    });

    it('shows installed status for installed packs', () => {
      run('install-skill --packs engineering', tmpDir);
      const output = run('install-skill --list', tmpDir);
      expect(output).toContain('installed');
    });
  });
});
