import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import fg from 'fast-glob';
import { readFrontmatter } from './frontmatter.js';
import { buildKnowledgeIndex } from './knowledge-index.js';

export type GraphGroup =
  | 'soul'
  | 'user'
  | 'memory'
  | 'core'
  | 'feature'
  | 'task'
  | 'knowledge'
  | 'release'
  | 'inbox'
  | 'tag';

export interface GraphNode {
  id: string;
  label: string;
  group: GraphGroup;
  path: string;
  meta: {
    status?: string;
    priority?: string;
    tags?: string[];
    updated?: string;
    description?: string;
    slug?: string;
  };
}

export type GraphLinkKind =
  | 'related_feature'
  | 'parent_task'
  | 'release_includes'
  | 'sibling_core'
  | 'has_tag';

export interface GraphLink {
  source: string;
  target: string;
  kind: GraphLinkKind;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
}

interface FeatureRefs {
  relatedTasks: string[];
}

interface TaskRefs {
  relatedFeature: string | null;
  parentTask: string | null;
}

interface ReleaseRecord {
  id: string;
  version?: string;
  date?: string;
  summary?: string;
  features?: string[];
  tasks?: string[];
}

export function buildGraph(contextRoot: string): Graph {
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];
  const byId = new Map<string, GraphNode>();
  const bySlug = new Map<string, GraphNode>();
  const featureRefs = new Map<string, FeatureRefs>();
  const taskRefs = new Map<string, TaskRefs>();

  const addNode = (node: GraphNode, slug?: string) => {
    if (byId.has(node.id)) return;
    nodes.push(node);
    byId.set(node.id, node);
    if (slug) bySlug.set(slug, node);
  };

  const coreDir = join(contextRoot, 'core');

  // ─── Foundational core: soul / user / memory ─────────────────────────
  const foundational: Array<{ prefix: string; group: GraphGroup }> = [
    { prefix: '0', group: 'soul' },
    { prefix: '1', group: 'user' },
    { prefix: '2', group: 'memory' },
  ];
  for (const { prefix, group } of foundational) {
    if (!existsSync(coreDir)) continue;
    const matches = fg.sync(`${prefix}.*.md`, { cwd: coreDir, absolute: true });
    for (const file of matches) {
      try {
        const { data } = readFrontmatter(file);
        const filename = basename(file);
        addNode({
          id: `core/${filename}`,
          label: basename(filename, '.md'),
          group,
          path: `core/${filename}`,
          meta: {
            updated: data.updated ? String(data.updated) : undefined,
            tags: Array.isArray(data.tags) ? (data.tags as unknown[]).map(String) : undefined,
          },
        });
      } catch {
        /* skip */
      }
    }
  }

  // ─── Other core files (3+) ───────────────────────────────────────────
  if (existsSync(coreDir)) {
    const others = fg.sync('[3-9]*.md', { cwd: coreDir, absolute: true });
    for (const file of others) {
      const filename = basename(file);
      try {
        const { data } = readFrontmatter(file);
        addNode({
          id: `core/${filename}`,
          label: basename(filename, '.md'),
          group: 'core',
          path: `core/${filename}`,
          meta: {
            updated: data.updated ? String(data.updated) : undefined,
            tags: Array.isArray(data.tags) ? (data.tags as unknown[]).map(String) : undefined,
          },
        });
      } catch {
        /* skip */
      }
    }
  }

  // ─── Features ─────────────────────────────────────────────────────────
  const featuresDir = join(coreDir, 'features');
  if (existsSync(featuresDir)) {
    const files = fg.sync('*.md', { cwd: featuresDir, absolute: true });
    for (const file of files) {
      const fileSlug = basename(file, '.md');
      try {
        const { data } = readFrontmatter(file);
        const id = data.id ? String(data.id) : `feature/${fileSlug}`;
        addNode(
          {
            id,
            label: fileSlug,
            group: 'feature',
            path: `core/features/${fileSlug}.md`,
            meta: {
              status: data.status ? String(data.status) : undefined,
              tags: Array.isArray(data.tags) ? (data.tags as unknown[]).map(String) : undefined,
              updated: data.updated ? String(data.updated) : undefined,
              description: data.description ? String(data.description) : undefined,
              slug: fileSlug,
            },
          },
          fileSlug,
        );
        featureRefs.set(id, {
          relatedTasks: Array.isArray(data.related_tasks)
            ? (data.related_tasks as unknown[]).map(String)
            : [],
        });
      } catch {
        /* skip */
      }
    }
  }

  // ─── Tasks (state/*.md) ───────────────────────────────────────────────
  const stateDir = join(contextRoot, 'state');
  if (existsSync(stateDir)) {
    const files = fg.sync('*.md', { cwd: stateDir, absolute: true });
    for (const file of files) {
      const fileSlug = basename(file, '.md');
      try {
        const { data } = readFrontmatter(file);
        const id = data.id ? String(data.id) : `task/${fileSlug}`;
        const slug = data.name ? String(data.name) : fileSlug;
        addNode(
          {
            id,
            label: fileSlug,
            group: 'task',
            path: `state/${fileSlug}.md`,
            meta: {
              status: data.status ? String(data.status) : undefined,
              priority: data.priority ? String(data.priority) : undefined,
              tags: Array.isArray(data.tags) ? (data.tags as unknown[]).map(String) : undefined,
              updated: data.updated_at ? String(data.updated_at) : undefined,
              description: data.description ? String(data.description) : undefined,
              slug,
            },
          },
          slug,
        );
        taskRefs.set(id, {
          relatedFeature: data.related_feature ? String(data.related_feature) : null,
          parentTask: data.parent_task ? String(data.parent_task) : null,
        });
      } catch {
        /* skip */
      }
    }
  }

  // ─── Knowledge ────────────────────────────────────────────────────────
  const knowledge = buildKnowledgeIndex(contextRoot);
  for (const entry of knowledge) {
    addNode(
      {
        id: `knowledge/${entry.slug}`,
        label: entry.slug,
        group: 'knowledge',
        path: `knowledge/${entry.slug}.md`,
        meta: {
          tags: entry.tags,
          updated: entry.date,
          description: entry.description,
          slug: entry.slug,
        },
      },
      entry.slug,
    );
  }

  // ─── Inbox ────────────────────────────────────────────────────────────
  const inboxDir = join(contextRoot, 'inbox');
  if (existsSync(inboxDir)) {
    const files = fg.sync('*.md', { cwd: inboxDir, absolute: true });
    for (const file of files) {
      const slug = basename(file, '.md');
      let label = slug;
      let description = '';
      try {
        const { data } = readFrontmatter(file);
        if (data.name) label = String(data.name);
        if (data.description) description = String(data.description);
      } catch {
        /* inbox files may not have frontmatter */
      }
      addNode({
        id: `inbox/${slug}`,
        label,
        group: 'inbox',
        path: `inbox/${slug}.md`,
        meta: { description: description || undefined, slug },
      });
    }
  }

  // ─── Releases ─────────────────────────────────────────────────────────
  const releasesPath = join(coreDir, 'RELEASES.json');
  let releases: ReleaseRecord[] = [];
  if (existsSync(releasesPath)) {
    try {
      const parsed = JSON.parse(readFileSync(releasesPath, 'utf-8'));
      if (Array.isArray(parsed)) releases = parsed as ReleaseRecord[];
    } catch {
      /* skip */
    }
  }
  for (const rel of releases) {
    if (!rel.id) continue;
    addNode({
      id: rel.id,
      label: rel.version ? `v${rel.version}` : rel.id,
      group: 'release',
      path: `core/RELEASES.json#${rel.version ?? rel.id}`,
      meta: {
        updated: rel.date,
        description: rel.summary,
      },
    });
  }

  // ─── EDGE RESOLUTION ──────────────────────────────────────────────────

  // Feature → Task (via related_tasks; slugs)
  for (const [featureId, refs] of featureRefs) {
    for (const taskSlug of refs.relatedTasks) {
      const taskNode = bySlug.get(taskSlug);
      if (taskNode && taskNode.group === 'task') {
        links.push({ source: taskNode.id, target: featureId, kind: 'related_feature' });
      }
    }
  }

  // Task → Feature (via related_feature ID), Task → Parent Task
  for (const [taskId, refs] of taskRefs) {
    if (refs.relatedFeature) {
      const featureNode = byId.get(refs.relatedFeature);
      if (featureNode) {
        const exists = links.some(
          (l) =>
            l.kind === 'related_feature' && l.source === taskId && l.target === featureNode.id,
        );
        if (!exists) {
          links.push({ source: taskId, target: featureNode.id, kind: 'related_feature' });
        }
      }
    }
    if (refs.parentTask) {
      const parent = byId.get(refs.parentTask);
      if (parent) {
        links.push({ source: taskId, target: parent.id, kind: 'parent_task' });
      }
    }
  }

  // Releases → Features/Tasks
  for (const rel of releases) {
    if (!rel.id || !byId.has(rel.id)) continue;
    for (const featId of rel.features ?? []) {
      if (byId.has(featId)) {
        links.push({ source: rel.id, target: featId, kind: 'release_includes' });
      }
    }
    for (const taskId of rel.tasks ?? []) {
      if (byId.has(taskId)) {
        links.push({ source: rel.id, target: taskId, kind: 'release_includes' });
      }
    }
  }

  // Core spine: soul → user → memory (anchors the graph)
  const soul = nodes.find((n) => n.group === 'soul');
  const user = nodes.find((n) => n.group === 'user');
  const memory = nodes.find((n) => n.group === 'memory');
  if (soul && user) links.push({ source: soul.id, target: user.id, kind: 'sibling_core' });
  if (user && memory) links.push({ source: user.id, target: memory.id, kind: 'sibling_core' });

  // ─── Tag nodes (Obsidian-style: tags become first-class nodes) ───────
  // Snapshot nodes before tag insertion so we iterate a stable set.
  const taggable = nodes.slice();
  for (const node of taggable) {
    const tags = node.meta.tags;
    if (!tags || tags.length === 0) continue;
    for (const rawTag of tags) {
      const tag = String(rawTag).trim();
      if (!tag) continue;
      const tagId = `tag/${tag}`;
      if (!byId.has(tagId)) {
        addNode({
          id: tagId,
          label: `#${tag}`,
          group: 'tag',
          path: '',
          meta: {},
        });
      }
      links.push({ source: node.id, target: tagId, kind: 'has_tag' });
    }
  }

  return { nodes, links };
}
