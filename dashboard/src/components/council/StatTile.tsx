interface Props {
  value: number | string;
  label: string;
  tone?: 'default' | 'warning' | 'dissent' | 'brand';
}

export function StatTile({ value, label, tone = 'default' }: Props) {
  return (
    <div className={`council-stat-tile council-stat-tile--${tone}`}>
      <div className="council-stat-value">{value}</div>
      <div className="council-stat-label">{label}</div>
    </div>
  );
}
