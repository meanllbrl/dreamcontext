import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';
import type { GraphNode } from './useGraph';

export interface NodeContentMarkdown {
  type: 'markdown';
  path: string;
  frontmatter: Record<string, unknown>;
  content: string;
}

export interface NodeContentJson {
  type: 'json';
  path: string;
  data?: unknown;
  raw?: string;
}

export interface NodeContentText {
  type: 'text';
  path: string;
  content: string;
}

export type NodeContent = NodeContentMarkdown | NodeContentJson | NodeContentText;

export function useNodeContent(node: GraphNode | null) {
  return useQuery({
    queryKey: ['graph', 'content', node?.path ?? null],
    queryFn: () => {
      if (!node || !node.path) throw new Error('No path for node');
      return api.get<NodeContent>(`/graph/content?path=${encodeURIComponent(node.path)}`);
    },
    enabled: !!(node && node.path),
    staleTime: 30_000,
  });
}
