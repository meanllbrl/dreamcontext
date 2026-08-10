import { useQuery } from '@tanstack/react-query';
import { useApi } from '../context/VaultContext';

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

export type GraphLinkKind =
  | 'related_feature'
  | 'parent_task'
  | 'release_includes'
  | 'sibling_core'
  | 'has_tag';

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

export interface GraphLink {
  source: string;
  target: string;
  kind: GraphLinkKind;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
}

export function useGraph() {
  const api = useApi();
  return useQuery({
    queryKey: ['graph'],
    queryFn: () => api.get<Graph>('/graph'),
    staleTime: 30_000,
  });
}
