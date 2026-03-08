import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export interface Task {
  slug: string;
  id: string;
  name: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  urgency: 'critical' | 'high' | 'medium' | 'low';
  status: 'todo' | 'in_progress' | 'in_review' | 'completed';
  created_at: string;
  updated_at: string;
  tags: string[];
  parent_task: string | null;
  related_feature: string | null;
  version: string | null;
  why: string;
  user_stories: string;
  acceptance_criteria: string;
  constraints: string;
  technical_details: string;
  notes: string;
  changelog: string;
  sections: string[];
  body: string;
}

interface TasksResponse {
  tasks: Task[];
}

interface TaskResponse {
  task: Task;
}

interface CreateTaskInput {
  name: string;
  description: string;
  priority: string;
  urgency?: string;
  tags?: string[];
  why?: string;
  version?: string;
}

interface UpdateTaskInput {
  slug: string;
  updates: Partial<Pick<Task, 'status' | 'priority' | 'urgency' | 'description' | 'tags' | 'name' | 'related_feature' | 'version'>>;
}

interface InsertTaskSectionInput {
  slug: string;
  section: string;
  content: string;
}

export function useTasks() {
  return useQuery({
    queryKey: ['tasks'],
    queryFn: () => api.get<TasksResponse>('/tasks'),
    select: (data) => data.tasks,
  });
}

export function useTask(slug: string) {
  return useQuery({
    queryKey: ['tasks', slug],
    queryFn: () => api.get<TaskResponse>(`/tasks/${slug}`),
    select: (data) => data.task,
    enabled: !!slug,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateTaskInput) => api.post<TaskResponse>('/tasks', input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, updates }: UpdateTaskInput) =>
      api.patch<TaskResponse>(`/tasks/${slug}`, updates),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useAddTaskChangelog() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, content }: { slug: string; content: string }) =>
      api.post<{ success: boolean }>(`/tasks/${slug}/changelog`, { content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

export function useInsertTaskSection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ slug, section, content }: InsertTaskSectionInput) =>
      api.post<{ success: boolean }>(`/tasks/${slug}/insert`, { section, content }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}
