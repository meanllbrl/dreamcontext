/* ───────────────────────────────────────────────────────────────────────────
 * design-sync bundle entry — GENERATED/MAINTAINED by the /design-sync skill.
 *
 * This is NOT part of the dashboard app; nothing imports it. It exists solely
 * to give esbuild a single entry that (a) pulls the design foundation (fonts +
 * tokens + reset) and the council-primitive styles into _ds_bundle.css in the
 * right order, and (b) re-exports exactly the subset of components synced to
 * claude.ai/design. Each component module imports its own co-located CSS, so
 * that styling rides in automatically after the foundation below.
 *
 * To add/remove a synced component: edit both this file and
 * `componentSrcMap` in .design-sync/config.json, then re-run the converter.
 * ─────────────────────────────────────────────────────────────────────────── */

// ── Design foundation (order matters: tokens define the vars everything uses) ──
import './_ds_fonts.css';
import './src/styles/tokens.css';
import './src/styles/reset.css';
import './src/components/council/_ds-council-primitives.css';
import './src/components/tasks/_ds-task-controls.css';

// ── Synced components ──────────────────────────────────────────────────────
// council primitives
export { StatusBadge } from './src/components/council/StatusBadge';
export { ModelBadge } from './src/components/council/ModelBadge';
export { StatTile } from './src/components/council/StatTile';
export { PersonaAvatar } from './src/components/council/PersonaAvatar';
// task primitives
export { TaskCard } from './src/components/tasks/TaskCard';
export { KanbanColumn } from './src/components/tasks/KanbanColumn';
export { SubGroupSection } from './src/components/tasks/SubGroupSection';
export { MiniCalendar } from './src/components/tasks/MiniCalendar';
export { SearchableSelect } from './src/components/tasks/SearchableSelect';
export { MultiSelectFilter } from './src/components/tasks/MultiSelectFilter';
export { FilterPopover } from './src/components/tasks/FilterPopover';
export { CustomFieldInput } from './src/components/tasks/CustomFieldInput';
export { ActivityHeatmap } from './src/components/tasks/ActivityHeatmap';
export { EisenhowerMatrix } from './src/components/tasks/EisenhowerMatrix';
export { RiceScatter } from './src/components/tasks/RiceScatter';
export { VersionFilter } from './src/components/tasks/VersionFilter';
