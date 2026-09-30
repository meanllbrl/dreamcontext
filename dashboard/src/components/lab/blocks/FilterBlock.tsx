import { useI18n } from '../../../context/I18nContext';
import { applyFrameOps, distinctValues } from '../../../generated/frameOps';
import { BlockEmpty, drawableFrame, stringOption, type BlockViewProps } from './blockCommon';
import { formatStat } from './format';

/**
 * `filter`: a chip row over one dim of a dataset. Choosing a chip publishes
 * `{dim, value}` through `onFilter`; the card narrows every sibling block
 * bound to the same dataset client-side (frameShape.ts, the mirrored
 * frameOps), so nothing is fetched. `dim` defaults to the dataset's first dim.
 *
 * The row ends with the filtered total: the dataset narrowed to the chosen
 * chip through the same frameOps pass the siblings run, so the count and sum
 * are taken after the filter and before any sibling's `limit`.
 */
export function FilterBlock({ frame, options, filter, onFilter }: BlockViewProps) {
  const { t } = useI18n();
  const drawable = drawableFrame(frame, ['table'] as const);
  if ('empty' in drawable) return <BlockEmpty reason={drawable.empty} />;
  const f = drawable.frame;
  const dim = stringOption(options, 'dim') ?? f.dims[0]?.key ?? null;
  if (!dim || !f.dims.some((d) => d.key === dim)) return <BlockEmpty message={t('lab.blocks.filter.noDim')} />;
  const values = distinctValues(f, dim);
  const active = filter && filter.dim === dim ? filter.value : null;
  const label = f.dims.find((d) => d.key === dim)?.label ?? dim;
  const narrowed = applyFrameOps(f, { filter: active === null ? null : { dim, value: active } });
  const total = narrowed.kind === 'table' ? narrowed.total : f.total;
  const totalText = t('lab.blocks.filter.total')
    .replace('{n}', total.count.toLocaleString())
    .replace('{v}', total.v === null ? '' : `${formatStat(total.v, 'number', null)}${f.unit ? ` ${f.unit}` : ''}`);

  return (
    <div className="lab-block-filter" role="toolbar" aria-label={label} data-dim={dim} onClick={(e) => e.stopPropagation()}>
      <span className="lab-block-filter-label">{label}</span>
      <button
        type="button"
        className="lab-block-chip"
        aria-pressed={active === null}
        onClick={() => onFilter?.(null)}
      >{t('lab.blocks.filter.all')}</button>
      {values.map((value) => (
        <button
          key={value}
          type="button"
          data-lab-filter-chip={value}
          className="lab-block-chip"
          aria-pressed={active === value}
          onClick={() => onFilter?.(active === value ? null : { dim, value })}
        >{value}</button>
      ))}
      <span className="lab-block-filter-total" data-lab-filter-total={total.count} aria-live="polite">{totalText}</span>
    </div>
  );
}
