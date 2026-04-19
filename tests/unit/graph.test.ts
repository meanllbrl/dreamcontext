import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { buildGraph } from '../../src/lib/graph.js';

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-graph-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFile(path: string, content: string): void {
  writeFileSync(path, content, 'utf-8');
}

function scaffold(root: string) {
  mkdirSync(join(root, 'core', 'features'), { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  mkdirSync(join(root, 'knowledge'), { recursive: true });
  mkdirSync(join(root, 'inbox'), { recursive: true });
}

describe('buildGraph', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    scaffold(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty graph for empty context', () => {
    const g = buildGraph(tmpDir);
    expect(g.nodes).toEqual([]);
    expect(g.links).toEqual([]);
  });

  it('creates soul/user/memory nodes and links them as a spine', () => {
    writeFile(join(tmpDir, 'core', '0.soul.md'), '---\nname: test-project\ntype: soul\n---\n\nbody');
    writeFile(join(tmpDir, 'core', '1.user.md'), '---\nname: user profile\ntype: user\n---\n\nbody');
    writeFile(join(tmpDir, 'core', '2.memory.md'), '---\nname: memory\ntype: memory\n---\n\nbody');

    const g = buildGraph(tmpDir);
    const groups = g.nodes.map((n) => n.group).sort();
    expect(groups).toEqual(['memory', 'soul', 'user']);

    const spineLinks = g.links.filter((l) => l.kind === 'sibling_core');
    expect(spineLinks).toHaveLength(2);
  });

  it('creates feature and task nodes and resolves related_feature by ID', () => {
    writeFile(
      join(tmpDir, 'core', 'features', 'web-dashboard.md'),
      '---\nid: feat_ABC\nname: Web Dashboard\nstatus: active\nrelated_tasks: []\n---\n\nbody',
    );
    writeFile(
      join(tmpDir, 'state', 'build-dashboard.md'),
      '---\nid: task_XYZ\nname: build-dashboard\nstatus: in_progress\npriority: high\nrelated_feature: feat_ABC\n---\n\nbody',
    );

    const g = buildGraph(tmpDir);
    expect(g.nodes.find((n) => n.id === 'feat_ABC')?.group).toBe('feature');
    expect(g.nodes.find((n) => n.id === 'task_XYZ')?.group).toBe('task');

    const rel = g.links.find((l) => l.kind === 'related_feature');
    expect(rel).toBeDefined();
    expect(rel?.source).toBe('task_XYZ');
    expect(rel?.target).toBe('feat_ABC');
  });

  it('resolves related_tasks by slug (feature -> task direction)', () => {
    writeFile(
      join(tmpDir, 'core', 'features', 'auth.md'),
      '---\nid: feat_AUTH\nname: Auth\nstatus: active\nrelated_tasks:\n  - login-flow\n---\n\nbody',
    );
    writeFile(
      join(tmpDir, 'state', 'login-flow.md'),
      '---\nid: task_LOGIN\nname: login-flow\nstatus: todo\npriority: high\n---\n\nbody',
    );

    const g = buildGraph(tmpDir);
    const rel = g.links.find((l) => l.kind === 'related_feature');
    expect(rel?.source).toBe('task_LOGIN');
    expect(rel?.target).toBe('feat_AUTH');
  });

  it('does not duplicate feature↔task edges when both directions declared', () => {
    writeFile(
      join(tmpDir, 'core', 'features', 'billing.md'),
      '---\nid: feat_BILL\nname: Billing\nstatus: active\nrelated_tasks:\n  - stripe-integration\n---\n\nbody',
    );
    writeFile(
      join(tmpDir, 'state', 'stripe-integration.md'),
      '---\nid: task_STRIPE\nname: stripe-integration\nstatus: in_progress\npriority: critical\nrelated_feature: feat_BILL\n---\n\nbody',
    );

    const g = buildGraph(tmpDir);
    const edges = g.links.filter(
      (l) => l.kind === 'related_feature' && l.source === 'task_STRIPE' && l.target === 'feat_BILL',
    );
    expect(edges).toHaveLength(1);
  });

  it('resolves parent_task edges between tasks', () => {
    writeFile(
      join(tmpDir, 'state', 'parent.md'),
      '---\nid: task_P\nname: parent\nstatus: in_progress\npriority: high\n---\n\nbody',
    );
    writeFile(
      join(tmpDir, 'state', 'child.md'),
      '---\nid: task_C\nname: child\nstatus: todo\npriority: medium\nparent_task: task_P\n---\n\nbody',
    );

    const g = buildGraph(tmpDir);
    const parent = g.links.find((l) => l.kind === 'parent_task');
    expect(parent?.source).toBe('task_C');
    expect(parent?.target).toBe('task_P');
  });

  it('creates release nodes and release_includes edges', () => {
    writeFile(
      join(tmpDir, 'core', 'features', 'auth.md'),
      '---\nid: feat_AUTH\nname: Auth\nstatus: active\n---\n\nbody',
    );
    writeFile(
      join(tmpDir, 'state', 'login-task.md'),
      '---\nid: task_LOGIN\nname: login-task\nstatus: completed\npriority: high\n---\n\nbody',
    );
    writeFile(
      join(tmpDir, 'core', 'RELEASES.json'),
      JSON.stringify([
        {
          id: 'rel_v1',
          version: '0.1.0',
          date: '2026-01-01',
          summary: 'Initial',
          features: ['feat_AUTH'],
          tasks: ['task_LOGIN'],
        },
      ]),
    );

    const g = buildGraph(tmpDir);
    expect(g.nodes.find((n) => n.id === 'rel_v1')?.group).toBe('release');
    const relEdges = g.links.filter((l) => l.kind === 'release_includes');
    expect(relEdges).toHaveLength(2);
    expect(relEdges.every((l) => l.source === 'rel_v1')).toBe(true);
  });

  it('silently drops stale references to nonexistent nodes', () => {
    writeFile(
      join(tmpDir, 'state', 'orphan.md'),
      '---\nid: task_ORPHAN\nname: orphan\nstatus: todo\npriority: low\nrelated_feature: feat_DOES_NOT_EXIST\nparent_task: task_MISSING\n---\n\nbody',
    );
    writeFile(
      join(tmpDir, 'core', 'RELEASES.json'),
      JSON.stringify([{ id: 'rel_bad', version: '0.0.1', features: ['feat_GHOST'], tasks: ['task_GHOST'] }]),
    );

    const g = buildGraph(tmpDir);
    expect(g.links.filter((l) => l.kind === 'related_feature')).toHaveLength(0);
    expect(g.links.filter((l) => l.kind === 'parent_task')).toHaveLength(0);
    expect(g.links.filter((l) => l.kind === 'release_includes')).toHaveLength(0);
    // Node should still exist
    expect(g.nodes.find((n) => n.id === 'task_ORPHAN')).toBeDefined();
  });

  it('ingests knowledge entries', () => {
    writeFile(
      join(tmpDir, 'knowledge', 'auth-flow.md'),
      '---\nname: Auth Flow\ndescription: JWT\ntags:\n  - security\n  - backend\ndate: "2026-02-01"\npinned: false\n---\n\nbody',
    );

    const g = buildGraph(tmpDir);
    const node = g.nodes.find((n) => n.id === 'knowledge/auth-flow');
    expect(node?.group).toBe('knowledge');
    expect(node?.meta.tags).toEqual(['security', 'backend']);
  });

  it('handles inbox files with or without frontmatter', () => {
    writeFile(join(tmpDir, 'inbox', 'no-frontmatter.md'), 'just text, no frontmatter\n');
    writeFile(
      join(tmpDir, 'inbox', 'with-frontmatter.md'),
      '---\nname: Stashed Idea\ndescription: Thought dump\n---\n\nbody',
    );

    const g = buildGraph(tmpDir);
    const inboxNodes = g.nodes.filter((n) => n.group === 'inbox');
    expect(inboxNodes).toHaveLength(2);
    const named = inboxNodes.find((n) => n.label === 'Stashed Idea');
    expect(named).toBeDefined();
  });

  it('does not throw when RELEASES.json is malformed', () => {
    writeFile(join(tmpDir, 'core', 'RELEASES.json'), '{ not valid json');
    expect(() => buildGraph(tmpDir)).not.toThrow();
  });
});
