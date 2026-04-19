import { useState, type CSSProperties } from 'react';
import type { GraphColorGroup, GraphSettings } from '../../hooks/useGraphSettings';

type SectionKey = 'filters' | 'groups' | 'display' | 'forces';

interface BrainSettingsProps {
  settings: GraphSettings;
  patch: <K extends keyof GraphSettings>(section: K, updates: Partial<GraphSettings[K]>) => void;
  setGroups: (groups: GraphColorGroup[]) => void;
  reset: () => void;
  onClose: () => void;
}

const SECTION_LABELS: Record<SectionKey, string> = {
  filters: 'Filters',
  groups: 'Groups',
  display: 'Display',
  forces: 'Forces',
};

const GROUP_SWATCHES = [
  '#10b981', // emerald
  '#4fb3e6', // cyan
  '#a78bfa', // purple
  '#f59e0b', // amber
  '#ef4444', // red
  '#e11d74', // magenta
  '#9ca3af', // gray
  '#eab308', // yellow
  '#22d3ee', // teal
  '#f472b6', // pink
];

export function BrainSettings({ settings, patch, setGroups, reset, onClose }: BrainSettingsProps) {
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    filters: true,
    groups: true,
    display: true,
    forces: true,
  });

  const toggle = (k: SectionKey) => setOpen((p) => ({ ...p, [k]: !p[k] }));

  return (
    <aside className="brain-settings">
      <div className="brain-settings-header">
        <span className="brain-settings-title">Graph settings</span>
        <div className="brain-settings-header-actions">
          <button className="brain-settings-mini-btn" onClick={reset} title="Restore default settings">
            ↻
          </button>
          <button className="brain-settings-mini-btn" onClick={onClose} title="Close">
            ×
          </button>
        </div>
      </div>

      <div className="brain-settings-body">
        {/* ─── Filters ─── */}
        <Section
          label={SECTION_LABELS.filters}
          open={open.filters}
          onToggle={() => toggle('filters')}
        >
          <label className="brain-settings-label">Search files</label>
          <input
            type="search"
            className="brain-settings-input"
            placeholder="Search…"
            value={settings.filters.search}
            onChange={(e) => patch('filters', { search: e.target.value })}
          />
          <p className="brain-settings-hint">
            Operators: <code>tag:</code> <code>path:</code> <code>file:</code> <code>-not</code>{' '}
            <code>OR</code> <code>"phrase"</code> <code>/regex/</code>
          </p>

          <ToggleRow
            label="Tags"
            checked={settings.filters.showTags}
            onChange={(v) => patch('filters', { showTags: v })}
          />
          <ToggleRow
            label="Attachments"
            checked={settings.filters.showAttachments}
            onChange={(v) => patch('filters', { showAttachments: v })}
          />
          <ToggleRow
            label="Existing files only"
            checked={settings.filters.existingFilesOnly}
            onChange={(v) => patch('filters', { existingFilesOnly: v })}
          />
          <ToggleRow
            label="Orphans"
            checked={settings.filters.showOrphans}
            onChange={(v) => patch('filters', { showOrphans: v })}
          />
        </Section>

        {/* ─── Groups ─── */}
        <Section label={SECTION_LABELS.groups} open={open.groups} onToggle={() => toggle('groups')}>
          <GroupsEditor groups={settings.groups} onChange={setGroups} />
        </Section>

        {/* ─── Display ─── */}
        <Section
          label={SECTION_LABELS.display}
          open={open.display}
          onToggle={() => toggle('display')}
        >
          <ToggleRow
            label="Arrows"
            checked={settings.display.arrows}
            onChange={(v) => patch('display', { arrows: v })}
          />
          <SliderRow
            label="Text fade threshold"
            value={settings.display.textFadeThreshold}
            onChange={(v) => patch('display', { textFadeThreshold: v })}
          />
          <SliderRow
            label="Node size"
            value={settings.display.nodeSize}
            onChange={(v) => patch('display', { nodeSize: v })}
          />
          <SliderRow
            label="Link thickness"
            value={settings.display.linkThickness}
            onChange={(v) => patch('display', { linkThickness: v })}
          />
        </Section>

        {/* ─── Forces ─── */}
        <Section label={SECTION_LABELS.forces} open={open.forces} onToggle={() => toggle('forces')}>
          <SliderRow
            label="Center force"
            value={settings.forces.centerStrength}
            onChange={(v) => patch('forces', { centerStrength: v })}
          />
          <SliderRow
            label="Repel force"
            value={settings.forces.repelStrength}
            onChange={(v) => patch('forces', { repelStrength: v })}
          />
          <SliderRow
            label="Link force"
            value={settings.forces.linkStrength}
            onChange={(v) => patch('forces', { linkStrength: v })}
          />
          <SliderRow
            label="Link distance"
            value={settings.forces.linkDistance}
            onChange={(v) => patch('forces', { linkDistance: v })}
          />
        </Section>
      </div>
    </aside>
  );
}

function Section({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`brain-section ${open ? 'brain-section--open' : ''}`}>
      <button className="brain-section-header" onClick={onToggle} type="button">
        <span className="brain-section-caret">{open ? '▾' : '▸'}</span>
        <span>{label}</span>
      </button>
      {open && <div className="brain-section-body">{children}</div>}
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="brain-toggle-row">
      <span>{label}</span>
      <span className={`brain-toggle ${checked ? 'brain-toggle--on' : ''}`} onClick={() => onChange(!checked)}>
        <span className="brain-toggle-knob" />
      </span>
    </label>
  );
}

function SliderRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <label className="brain-slider-row">
      <span className="brain-slider-label-text">{label}</span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
      />
    </label>
  );
}

function GroupsEditor({
  groups,
  onChange,
}: {
  groups: GraphColorGroup[];
  onChange: (groups: GraphColorGroup[]) => void;
}) {
  const [newQuery, setNewQuery] = useState('');
  const [picker, setPicker] = useState<string | null>(null);

  const add = () => {
    const q = newQuery.trim();
    if (!q) return;
    const id = `grp_${Math.random().toString(36).slice(2, 8)}`;
    onChange([...groups, { id, query: q, color: GROUP_SWATCHES[groups.length % GROUP_SWATCHES.length] }]);
    setNewQuery('');
  };

  const updateGroup = (id: string, upd: Partial<GraphColorGroup>) => {
    onChange(groups.map((g) => (g.id === id ? { ...g, ...upd } : g)));
  };

  const remove = (id: string) => onChange(groups.filter((g) => g.id !== id));

  return (
    <>
      {groups.length === 0 && (
        <p className="brain-settings-hint">
          Color nodes that match a query. First matching group wins. Example:{' '}
          <code>tag:#architecture</code>
        </p>
      )}
      <div className="brain-groups-list">
        {groups.map((g) => (
          <div key={g.id} className="brain-group-row">
            <button
              className="brain-group-color"
              style={{ background: g.color } as CSSProperties}
              onClick={() => setPicker(picker === g.id ? null : g.id)}
              title="Pick color"
            />
            <input
              className="brain-settings-input brain-group-input"
              value={g.query}
              onChange={(e) => updateGroup(g.id, { query: e.target.value })}
            />
            <button
              className="brain-settings-mini-btn"
              onClick={() => remove(g.id)}
              title="Remove group"
            >
              ×
            </button>
            {picker === g.id && (
              <div className="brain-swatch-picker">
                {GROUP_SWATCHES.map((c) => (
                  <button
                    key={c}
                    className="brain-swatch"
                    style={{ background: c } as CSSProperties}
                    onClick={() => {
                      updateGroup(g.id, { color: c });
                      setPicker(null);
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="brain-group-add">
        <input
          className="brain-settings-input"
          placeholder="New group query…"
          value={newQuery}
          onChange={(e) => setNewQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add();
          }}
        />
        <button className="brain-settings-btn" onClick={add} disabled={!newQuery.trim()}>
          New group
        </button>
      </div>
    </>
  );
}
