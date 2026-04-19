import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export interface DebateIndexEntry {
  id: string;
  topic: string;
  status: string;
  rounds_planned: number;
  current_round: number;
  promoted_to_knowledge: string | null;
  created_at: string;
  updated_at: string;
  personaSlugs?: string[];
}

export interface DebateFrontmatter {
  id: string;
  topic: string;
  status: string;
  rounds_planned: number;
  current_round: number;
  interrupt_between_rounds: boolean;
  personas: string[];
  promoted_to_knowledge: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonaFrontmatter {
  name: string;
  model: string;
  aspects: string[];
  round_entries: number;
}

export interface ResearchIndexEntry {
  slug: string;
  topic: string;
  added_at: string;
}

export interface ParsedRound {
  round: number;
  body: string;
  executiveSummary: string | null;
  position: string | null;
  reasoning: string | null;
  reactions: string | null;
  openQuestions: string | null;
}

export interface PersonaDetail {
  slug: string;
  frontmatter: PersonaFrontmatter;
  persona: string;
  crossContext: Record<number, string>;
  rounds: ParsedRound[];
  researches: ResearchIndexEntry[];
}

export interface DebateDetail {
  frontmatter: DebateFrontmatter;
  body: string;
  roundLog: string | null;
  finalReport: { frontmatter: Record<string, unknown>; content: string } | null;
  personas: PersonaDetail[];
}

interface CouncilListResponse {
  debates: DebateIndexEntry[];
}

interface CouncilDebateResponse {
  debate: DebateDetail;
}

export function useCouncilList() {
  return useQuery({
    queryKey: ['council'],
    queryFn: () => api.get<CouncilListResponse>('/council'),
    select: (data) => data.debates,
  });
}

export function useCouncilDebate(debateId: string | null) {
  return useQuery({
    queryKey: ['council', debateId],
    queryFn: () => api.get<CouncilDebateResponse>(`/council/${debateId}`),
    select: (data) => data.debate,
    enabled: !!debateId,
  });
}
