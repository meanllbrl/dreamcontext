import { useMemo, useEffect, useRef, useState, useCallback, Fragment } from 'react';
import { parseSqlContent, type SchemaEntity, type SchemaField, type SchemaRelation, type ParsedSchema } from '../../lib/sql-parser';
import './SqlPreview.css';

interface PathData {
  d: string;
  labelX: number;
  labelY: number;
  label: string;
}

function entityId(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-');
}

function typeCategory(type: string): string {
  if (type === 'enum') return 'enum';
  if (type === 'array' || type.endsWith('[]') || type.startsWith('array')) return 'array';
  if (type === 'boolean') return 'boolean';
  if (type === 'nullable') return 'nullable';
  if (type === 'date' || type === 'timestamp') return 'date';
  if (type === 'int' || type === 'integer' || type === 'numeric' || type === 'serial' || type === 'bigint' || type === 'smallint' || type === 'real' || type === 'float' || type === 'double') return 'number';
  if (type === 'jsonb' || type === 'json') return 'json';
  return 'string';
}

function fieldIcon(
  field: SchemaField,
  relations: SchemaRelation[],
  entityName: string,
): { icon: string; cls: string } | null {
  if (field.isPrimary) return { icon: 'PK', cls: 'entity-field-icon--key' };
  const isRef = relations.some(r => r.from === entityName && r.fromField === field.name);
  if (isRef) return { icon: 'FK', cls: 'entity-field-icon--ref' };
  return null;
}

function computePath(
  fromRect: DOMRect,
  toRect: DOMRect,
  cRect: DOMRect,
  isSelfRef: boolean,
): { d: string; labelX: number; labelY: number } {
  if (isSelfRef) {
    const x = fromRect.right - cRect.left;
    const y = fromRect.top + fromRect.height * 0.35 - cRect.top;
    const lw = 36;
    const lh = 28;
    return {
      d: `M ${x},${y} C ${x + lw},${y - lh * 0.3} ${x + lw},${y - lh * 1.3} ${x},${y - lh}`,
      labelX: x + lw + 4,
      labelY: y - lh * 0.5,
    };
  }

  const fCx = fromRect.left + fromRect.width / 2 - cRect.left;
  const tCx = toRect.left + toRect.width / 2 - cRect.left;
  const fCy = fromRect.top + fromRect.height / 2 - cRect.top;
  const tCy = toRect.top + toRect.height / 2 - cRect.top;
  const dx = Math.abs(fCx - tCx);
  const dy = Math.abs(fCy - tCy);

  let x1: number, y1: number, x2: number, y2: number;

  if (dx > dy) {
    if (fCx < tCx) {
      x1 = fromRect.right - cRect.left;
      x2 = toRect.left - cRect.left;
    } else {
      x1 = fromRect.left - cRect.left;
      x2 = toRect.right - cRect.left;
    }
    y1 = fCy;
    y2 = tCy;
    const cp = (x2 - x1) * 0.4;
    return {
      d: `M ${x1},${y1} C ${x1 + cp},${y1} ${x2 - cp},${y2} ${x2},${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 10,
    };
  }

  x1 = fCx;
  x2 = tCx;
  if (fCy < tCy) {
    y1 = fromRect.bottom - cRect.top;
    y2 = toRect.top - cRect.top;
  } else {
    y1 = fromRect.top - cRect.top;
    y2 = toRect.bottom - cRect.top;
  }
  const cp = (y2 - y1) * 0.4;
  return {
    d: `M ${x1},${y1} C ${x1},${y1 + cp} ${x2},${y2 - cp} ${x2},${y2}`,
    labelX: (x1 + x2) / 2,
    labelY: (y1 + y2) / 2 - 10,
  };
}

// ── Entity Card ──

function EntityCard({ entity, relations }: { entity: SchemaEntity; relations: SchemaRelation[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const categoryIcon = entity.storageType === 'json' ? '{ }' : entity.storageType === 'table' ? 'SQL' : '\u2630';

  // Separate top-level and nested fields
  const topLevel = entity.fields.filter(f => !f.isNested);
  const nestedByParent = useMemo(() => {
    const map = new Map<string, SchemaField[]>();
    for (const f of entity.fields) {
      if (f.isNested && f.parentField) {
        const list = map.get(f.parentField) || [];
        list.push(f);
        map.set(f.parentField, list);
      }
    }
    return map;
  }, [entity.fields]);

  const toggle = (parent: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(parent)) next.delete(parent);
      else next.add(parent);
      return next;
    });
  };

  return (
    <div className="entity-card" data-entity={entityId(entity.name)}>
      <div className="entity-card-header">
        <div className="entity-card-title-group">
          <span className="entity-card-category-icon">{categoryIcon}</span>
          <span className="entity-card-name">{entity.name}</span>
        </div>
        <span className="entity-card-badge" data-storage={entity.storageType}>
          {entity.storageType}
        </span>
      </div>

      {entity.path && (
        <div className="entity-card-path" title={entity.path}>{entity.path}</div>
      )}
      {entity.managedBy && (
        <div className="entity-card-managed">{entity.managedBy}</div>
      )}

      <div className="entity-fields">
        {topLevel.map(field => {
          const icon = fieldIcon(field, relations, entity.name);
          const cat = typeCategory(field.type);
          const nested = nestedByParent.get(field.name);
          const isExpanded = expanded.has(field.name);

          return (
            <Fragment key={field.name}>
              <div
                className={`entity-field${nested ? ' entity-field--expandable' : ''}`}
                onClick={nested ? () => toggle(field.name) : undefined}
              >
                <span className={`entity-field-icon ${icon?.cls ?? ''}`}>
                  {icon?.icon ?? ''}
                </span>
                <span className="entity-field-name">{field.name}</span>
                {field.type === 'enum' && field.enumValues ? (
                  <span className="entity-field-enum-group">
                    {field.enumValues.map(v => (
                      <span key={v} className="entity-field-enum-pill">{v}</span>
                    ))}
                  </span>
                ) : (
                  <span className="entity-field-type" data-type={cat}>{field.type}</span>
                )}
                {nested && (
                  <span className="entity-field-toggle">
                    <span className={`entity-field-toggle-arrow${isExpanded ? ' entity-field-toggle-arrow--open' : ''}`}>
                      &#9654;
                    </span>
                    <span className="entity-field-toggle-count">{nested.length}</span>
                  </span>
                )}
                {!nested && field.description && (
                  <span className="entity-field-desc" title={field.description}>
                    {field.description}
                  </span>
                )}
              </div>
              {nested && isExpanded && nested.map(nf => {
                const nCat = typeCategory(nf.type);
                const displayName = nf.name.slice((nf.parentField?.length ?? 0) + 1);
                return (
                  <div key={nf.name} className="entity-field entity-field--nested">
                    <span className="entity-field-icon" />
                    <span className="entity-field-name entity-field-name--nested">.{displayName}</span>
                    <span className="entity-field-type" data-type={nCat}>{nf.type}</span>
                    {nf.description && (
                      <span className="entity-field-desc" title={nf.description}>
                        {nf.description}
                      </span>
                    )}
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>

      {entity.notes.length > 0 && (
        <div className="entity-card-notes">
          {entity.notes.map((note, i) => (
            <div key={i} className="entity-card-note">{note}</div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Legend ──

function RelationshipLegend({ relations, entities }: { relations: SchemaRelation[]; entities: SchemaEntity[] }) {
  if (relations.length === 0) return null;

  return (
    <div className="sql-preview-legend">
      <div className="sql-preview-legend-title">Relationships</div>
      <div className="sql-preview-legend-items">
        {relations.map((rel, i) => {
          const fromName = entities.find(e => e.name === rel.from)?.name ?? rel.from;
          const toName = entities.find(e => e.name === rel.to)?.name ?? rel.to;
          const isSelf = rel.from === rel.to;
          return (
            <div key={i} className="sql-preview-legend-item">
              <span className="sql-preview-legend-line" />
              <span>
                {isSelf
                  ? `${fromName}.${rel.fromField} \u21BB self`
                  : `${fromName}.${rel.fromField} \u2192 ${toName}.${rel.toField}`}
              </span>
              <span className="sql-preview-legend-cardinality">{rel.cardinality}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Main Component ──

export function SqlPreview({ content }: { content: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<PathData[]>([]);
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 });

  const schema: ParsedSchema = useMemo(() => parseSqlContent(content), [content]);

  const updatePaths = useCallback(() => {
    const container = containerRef.current;
    if (!container || schema.relations.length === 0) {
      setPaths([]);
      return;
    }

    const cRect = container.getBoundingClientRect();
    setSvgSize({ width: container.scrollWidth, height: container.scrollHeight });

    const newPaths: PathData[] = [];
    for (const rel of schema.relations) {
      const fromEl = container.querySelector(`[data-entity="${entityId(rel.from)}"]`);
      const toEl = container.querySelector(`[data-entity="${entityId(rel.to)}"]`);
      if (!fromEl || !toEl) continue;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();
      const { d, labelX, labelY } = computePath(fromRect, toRect, cRect, rel.from === rel.to);
      newPaths.push({ d, labelX, labelY, label: rel.cardinality });
    }
    setPaths(newPaths);
  }, [schema]);

  useEffect(() => {
    const frame = requestAnimationFrame(updatePaths);
    const observer = new ResizeObserver(updatePaths);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [updatePaths]);

  // No CREATE TABLE / entity parsed (e.g. a comment-only or DDL-light fence).
  // Don't dead-end: show the raw SQL so the content is still readable, with a
  // hint that the relational view needs parseable table definitions.
  if (schema.entities.length === 0) {
    const hasSql = content.trim().length > 0;
    return (
      <div className="sql-preview">
        {hasSql ? (
          <>
            <div className="sql-preview-empty sql-preview-empty--hint">
              No table definitions to diagram — showing the raw SQL.
            </div>
            <pre className="sql-preview-raw"><code>{content.trim()}</code></pre>
          </>
        ) : (
          <div className="sql-preview-empty">No schema entities found in this file.</div>
        )}
      </div>
    );
  }

  return (
    <div className="sql-preview" ref={containerRef}>
      <svg
        className="sql-preview-svg"
        width={svgSize.width || '100%'}
        height={svgSize.height || '100%'}
        viewBox={svgSize.width ? `0 0 ${svgSize.width} ${svgSize.height}` : undefined}
      >
        <defs>
          <marker
            id="rel-arrowhead"
            viewBox="0 0 10 7"
            refX="9"
            refY="3.5"
            markerWidth="8"
            markerHeight="6"
            orient="auto"
          >
            <polygon points="0 0, 10 3.5, 0 7" className="sql-preview-arrowhead" />
          </marker>
        </defs>
        {paths.map((p, i) => (
          <g key={i}>
            <path d={p.d} className="sql-preview-line" markerEnd="url(#rel-arrowhead)" />
            <rect
              className="sql-preview-line-label-bg"
              x={p.labelX - 12}
              y={p.labelY - 7}
              width={24}
              height={14}
            />
            <text
              className="sql-preview-line-label"
              x={p.labelX}
              y={p.labelY + 4}
              textAnchor="middle"
            >
              {p.label}
            </text>
          </g>
        ))}
      </svg>

      <div className="sql-preview-grid">
        {schema.entities.map(entity => (
          <EntityCard key={entity.name} entity={entity} relations={schema.relations} />
        ))}
      </div>

      <RelationshipLegend relations={schema.relations} entities={schema.entities} />
    </div>
  );
}
