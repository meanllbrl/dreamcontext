import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export interface TaxonomyVocabulary {
  facetTags: Record<string, string[]>;
  aliases: Record<string, string>;
  bareTags: string[];
}

export interface TaxonomyAuditNonCanonical {
  doc: string;
  tag: string;
  suggestion: string;
}

export interface TaxonomyAudit {
  untagged: string[];
  nonCanonical: TaxonomyAuditNonCanonical[];
  orphan: string[];
  nearDups: [string, string][];
}

export interface TaxonomyResponse {
  vocabulary: TaxonomyVocabulary;
  usage: Record<string, number>;
  audit: TaxonomyAudit;
}

export function useTaxonomy() {
  return useQuery({
    queryKey: ['taxonomy'],
    queryFn: () => api.get<TaxonomyResponse>('/taxonomy'),
  });
}
