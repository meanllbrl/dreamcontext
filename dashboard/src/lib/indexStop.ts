/** The stopped-index sentence (Settings and the Super's agenda row): since when it is stale and why. */
export function indexStopLine(
  s: { reason: string; asOf: string | null; estUsd: number | null },
  t: (k: string) => string,
): string {
  const why = s.reason === 'daily_index_cap'
    ? t('settings.recall.cloud.stop.daily_cap')
    : s.reason === 'max_usd'
      ? t('settings.recall.cloud.stop.max_usd').replace('{usd}', (s.estUsd ?? 0).toFixed(2))
      : t('settings.recall.cloud.stop.failed');
  return t('settings.recall.cloud.stop.line')
    .replace('{date}', s.asOf ? s.asOf.slice(0, 10) : t('settings.recall.cloud.stop.never'))
    .replace('{why}', why);
}
