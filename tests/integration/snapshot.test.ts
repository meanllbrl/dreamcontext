import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-snap-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function scaffold(root: string) {
  const ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'core', 'features'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  return ctx;
}

function runSnapshot(cwd: string): string {
  const cliPath = join(__dirname, '..', '..', 'dist', 'index.js');
  try {
    return execSync(`node ${cliPath} snapshot`, { cwd, encoding: 'utf-8' });
  } catch (e: any) {
    return e.stdout ?? '';
  }
}

describe('snapshot (integration)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty output when _dream_context/ does not exist', () => {
    const output = runSnapshot(tmpDir);
    expect(output.trim()).toBe('');
  });

  it('outputs soul file content', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: Test Project\ntype: soul\n---\n\n## Project Identity\n\nA test project.\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Soul (Agent Identity, Principles, Rules)');
    expect(output).toContain('A test project.');
  });

  it('outputs user file content', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'core', '1.user.md'),
      '---\nname: user-preferences\ntype: user\n---\n\n## User Preferences\n\n- Prefers concise output.\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## User (Preferences, Project Details, Rules)');
    expect(output).toContain('Prefers concise output');
  });

  it('outputs memory file content fully', () => {
    const ctx = scaffold(tmpDir);
    const memoryLines = [
      '---',
      'name: active-memory',
      'type: memory',
      '---',
      '',
      '## Active Memory',
      '',
      '### 2026-02-24 - Session',
      '- Entry one.',
      '- Entry two.',
      '',
      '## Technical Decisions',
      '',
      '- Used TypeScript.',
      '- Chose vitest.',
      '',
      '## Known Issues',
      '',
      '- None.',
    ];
    writeFileSync(join(ctx, 'core', '2.memory.md'), memoryLines.join('\n'));
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Memory (Technical Decisions, Known Issues, Session Log)');
    expect(output).toContain('Entry one.');
    expect(output).toContain('Used TypeScript.');
    expect(output).toContain('Chose vitest.');
    expect(output).toContain('None.');
  });

  it('outputs active tasks (skipping completed)', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'state', 'my-task.md'),
      '---\nstatus: active\npriority: high\nupdated_at: "2026-02-24"\n---\n\n## Description\n\nDo the thing.\n',
    );
    writeFileSync(
      join(ctx, 'state', 'done-task.md'),
      '---\nstatus: completed\npriority: low\n---\n\n## Description\n\nAlready done.\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Active Tasks');
    expect(output).toContain('my-task');
    expect(output).not.toContain('done-task');
  });

  it('outputs recent changelog entries (max 3)', () => {
    const ctx = scaffold(tmpDir);
    const entries = Array.from({ length: 8 }, (_, i) => ({
      date: `2026-02-${String(24 - i).padStart(2, '0')}`,
      type: 'feat',
      scope: 'core',
      description: `Change ${i + 1}`,
    }));
    writeFileSync(join(ctx, 'core', 'CHANGELOG.json'), JSON.stringify(entries));
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Recent Changelog');
    expect(output).toContain('Change 1');
    expect(output).toContain('Change 3');
    expect(output).not.toContain('Change 4');
  });

  it('outputs features summary with why, tasks, and changelog', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'core', 'features', 'auth.md'),
      [
        '---',
        'name: Authentication',
        'status: active',
        'tags:',
        '  - security',
        '  - user',
        'related_tasks:',
        '  - implement-jwt',
        '---',
        '',
        '## Why',
        '',
        'Users need to log in securely',
        '',
        '## Changelog',
        '',
        '### 2026-02-25 - Update',
        '- Added OAuth flow',
        '',
        '### 2026-02-24 - Created',
        '- Feature PRD created.',
      ].join('\n'),
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Features');
    expect(output).toContain('auth');
    expect(output).toContain('status: active');
    expect(output).toContain('security, user');
    expect(output).toContain('Why: Users need to log in securely');
    expect(output).toContain('Tasks: implement-jwt');
    expect(output).toContain('Added OAuth flow');
  });

  it('outputs features summary without details when minimal', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'core', 'features', 'dashboard.md'),
      [
        '---',
        'status: planning',
        'tags: []',
        'related_tasks: []',
        '---',
        '',
        '## Why',
        '',
        '(To be defined)',
        '',
        '## Changelog',
        '',
        '### 2026-02-25 - Created',
        '- Feature PRD created.',
      ].join('\n'),
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('dashboard');
    expect(output).toContain('status: planning');
    expect(output).not.toContain('Why:');
    expect(output).not.toContain('Tasks:');
    expect(output).not.toContain('Latest:');
  });

  it('includes header line', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\n## Identity\n\nTest.\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('# Agent Context — Auto-loaded');
  });

  it('handles minimal context (only soul, no other files)', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: minimal\n---\n\nMinimal project.\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('Minimal project.');
    expect(output).not.toContain('## Active Tasks');
    expect(output).not.toContain('## Recent Changelog');
    expect(output).not.toContain('## Features');
  });

  it('handles malformed changelog gracefully', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest.\n',
    );
    writeFileSync(join(ctx, 'core', 'CHANGELOG.json'), 'NOT VALID JSON');
    const output = runSnapshot(tmpDir);
    // Should not crash, just skip changelog
    expect(output).toContain('Test.');
    expect(output).not.toContain('## Recent Changelog');
  });

  it('handles empty memory file', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(join(ctx, 'core', '2.memory.md'), '');
    const output = runSnapshot(tmpDir);
    // Empty memory should not produce a section
    expect(output).not.toContain('## Memory');
  });

  it('outputs knowledge index with descriptions and tags', () => {
    const ctx = scaffold(tmpDir);
    mkdirSync(join(ctx, 'knowledge'), { recursive: true });
    writeFileSync(
      join(ctx, 'knowledge', 'auth-system.md'),
      '---\nid: k1\nname: Auth System\ndescription: JWT-based auth flow\ntags:\n  - auth\n  - security\ndate: "2026-02-24"\n---\n\nDetailed auth content.\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Knowledge Index');
    expect(output).toContain('_dream_context/knowledge/auth-system.md');
    expect(output).toContain('JWT-based auth flow [auth, security]');
  });

  it('outputs pinned knowledge in full', () => {
    const ctx = scaffold(tmpDir);
    mkdirSync(join(ctx, 'knowledge'), { recursive: true });
    writeFileSync(
      join(ctx, 'knowledge', 'api-contract.md'),
      '---\nid: k2\nname: API Contract\ndescription: REST API spec\ntags:\n  - api\npinned: true\ndate: "2026-02-24"\n---\n\n## Endpoints\n\nGET /users - List users\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Pinned Knowledge');
    expect(output).toContain('### API Contract');
    expect(output).toContain('GET /users - List users');
  });

  it('does not output pinned section when no files are pinned', () => {
    const ctx = scaffold(tmpDir);
    mkdirSync(join(ctx, 'knowledge'), { recursive: true });
    writeFileSync(
      join(ctx, 'knowledge', 'topic.md'),
      '---\nid: k3\nname: Topic\ndescription: A topic\ntags: []\ndate: "2026-02-24"\n---\n\nContent.\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Knowledge Index');
    expect(output).not.toContain('## Pinned Knowledge');
  });

  it('outputs extended core files index with paths', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'core', '3.style_guide.md'),
      '---\nname: style-guide\ntype: style\n---\n\n## Branding\n\nContent.\n',
    );
    writeFileSync(
      join(ctx, 'core', '4.tech_stack.md'),
      '---\nname: tech-stack\ntype: tech\n---\n\n## Stack\n\nNode.js\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('## Extended Core Files');
    expect(output).toContain('_dream_context/core/3.style_guide.md');
    expect(output).toContain('_dream_context/core/4.tech_stack.md');
  });

  it('outputs extended core file summary when present', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'core', '4.tech_stack.md'),
      '---\nname: tech-stack\ntype: tech\nsummary: "Next.js 14 + PostgreSQL + Redis on AWS"\n---\n\n## Stack\n\nDetails.\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).toContain('Next.js 14 + PostgreSQL + Redis on AWS');
  });

  it('does not show extended core section when no 3+ files exist', () => {
    const ctx = scaffold(tmpDir);
    writeFileSync(
      join(ctx, 'core', '0.soul.md'),
      '---\nname: test\n---\n\nTest.\n',
    );
    const output = runSnapshot(tmpDir);
    expect(output).not.toContain('## Extended Core Files');
  });
});
