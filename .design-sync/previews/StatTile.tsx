import { StatTile } from 'dreamcontext-dashboard';

// StatTile is a compact mono-typeface stat used across the council overview HUD.
// The tone axis tints the value + border: default, brand, dissent, warning.

export const Rounds = () => <StatTile value={7} label="Rounds" />;

export const Consensus = () => <StatTile value="92%" label="Consensus" tone="brand" />;

export const Dissents = () => <StatTile value={3} label="Dissents" tone="dissent" />;

export const Status = () => <StatTile value="Stalled" label="Status" tone="warning" />;

export const OverviewStrip = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
    <StatTile value={7} label="Rounds" />
    <StatTile value={5} label="Personas" />
    <StatTile value="92%" label="Consensus" tone="brand" />
    <StatTile value={3} label="Dissents" tone="dissent" />
  </div>
);
