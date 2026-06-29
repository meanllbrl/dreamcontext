import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { MarkdownPreview } from '../core/MarkdownPreview';
import { SqlPreview } from '../core/SqlPreview';
import { ExcalidrawPreview } from '../core/ExcalidrawPreview';
import { isExcalidrawSlug } from '../../lib/excalidraw';
import type { RecallHit } from '../../hooks/useRecall';

/**
 * Renders an opened recall hit with the SAME components the dedicated pages use,
 * so a knowledge hit looks like the Knowledge page, a feature like the Features
 * page, a task like a task file, etc. The recall payload carries only *extracted*
 * text for boards, so we fetch the canonical record per type (knowledge / feature
 * / task) to get the raw content; memory & changelog render straight from the
 * recall body.
 */

const SQL_FENCE = /```sql\s*\n([\s\S]*?)```/gi;

function knowledgeSlug(path: string): string {
  return path.replace(/^.*?knowledge\//, '').replace(/\.md$/, '');
}

function extractSchemaSql(slug: string, content: string): string | null {
  if (!slug.startsWith('data-structures/')) return null;
  const blocks = [...content.matchAll(SQL_FENCE)].map((m) => m[1]);
  return blocks.length > 0 ? blocks.join('\n\n') : null;
}

interface DetailPlan { url: string; pick: (d: unknown) => string }

function detailPlan(hit: RecallHit): DetailPlan | null {
  switch (hit.type) {
    case 'knowledge':
      return { url: `/knowledge/${knowledgeSlug(hit.path)}`, pick: (d) => pick(d, ['entry', 'content']) };
    case 'feature':
      return { url: `/features/${hit.slug}`, pick: (d) => pick(d, ['feature', 'content']) };
    case 'task':
      return { url: `/tasks/${hit.slug}`, pick: (d) => pick(d, ['task', 'body']) };
    default:
      return null; // memory / changelog — no detail endpoint, use recall body
  }
}

function pick(obj: unknown, path: string[]): string {
  let cur: unknown = obj;
  for (const key of path) {
    if (cur && typeof cur === 'object' && key in cur) cur = (cur as Record<string, unknown>)[key];
    else return '';
  }
  return typeof cur === 'string' ? cur : '';
}

export function DocContent({ hit }: { hit: RecallHit }) {
  const plan = useMemo(() => detailPlan(hit), [hit]);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['docdetail', hit.type, hit.path, hit.slug],
    queryFn: () => api.get<unknown>(plan!.url),
    enabled: !!plan,
    staleTime: 30_000,
  });

  if (plan && isLoading) {
    return <div style={{ color: 'var(--text-5)', fontSize: '13px', padding: '8px 2px' }}>Loading document…</div>;
  }

  const content = plan && !isError && data ? plan.pick(data) : hit.body;

  if (hit.type === 'knowledge') {
    const kSlug = knowledgeSlug(hit.path);
    if (isExcalidrawSlug(kSlug)) {
      return (
        <div style={{ height: '440px', borderRadius: '10px', overflow: 'hidden', border: '1px solid var(--border)' }}>
          <ExcalidrawPreview content={content} slug={kSlug} />
        </div>
      );
    }
    const sql = extractSchemaSql(kSlug, content);
    if (sql) return <SqlPreview content={sql} />;
  }

  return <MarkdownPreview content={content} />;
}
