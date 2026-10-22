import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** AC2: the views other than the board are DELETED, not hidden, and nothing imports them. */
const ROOT = join(import.meta.dirname, '..', '..');
const TASKS = join(ROOT, 'dashboard', 'src', 'components', 'tasks');

const REMOVED = [
  'EisenhowerMatrix', 'eisenhower', 'RiceScatter', 'TimelineGantt', 'TaskCalendar', 'ActivityHeatmap', 'MiniCalendar',
  'TaskFilters', 'MultiSelectFilter', 'VersionFilter', 'VersionManager', 'KanbanColumn', 'SubGroupSection', 'TaskCard',
  'AtRiskAlert',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    if (f === 'node_modules' || f === 'dist') return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(tsx?|css)$/.test(f) ? [p] : [];
  });
}

describe('removed task views', () => {
  it.each(REMOVED)('%s is gone (component and stylesheet)', (name) => {
    for (const ext of ['.tsx', '.ts', '.css']) expect(existsSync(join(TASKS, name + ext)), name + ext).toBe(false);
  });

  it('KanbanBoard.css, stores/savedViews.ts and the eisenhower test are gone', () => {
    expect(existsSync(join(TASKS, 'KanbanBoard.css'))).toBe(false);
    expect(existsSync(join(ROOT, 'dashboard', 'src', 'stores', 'savedViews.ts'))).toBe(false);
    expect(existsSync(join(ROOT, 'tests', 'unit', 'eisenhower-matrix.test.ts'))).toBe(false);
  });

  it('nothing in dashboard/src imports a removed module', () => {
    const offenders: string[] = [];
    const re = new RegExp(`from\\s+['"][^'"]*/(${[...REMOVED, 'KanbanBoard\\.css', 'savedViews'].join('|')})(\\.css|\\.tsx?)?['"]`);
    for (const f of walk(join(ROOT, 'dashboard', 'src'))) {
      const src = readFileSync(f, 'utf-8');
      if (re.test(src) || /import\s+['"][^'"]*\/(TaskCard|KanbanBoard)\.css['"]/.test(src)) offenders.push(f.slice(ROOT.length + 1));
    }
    expect(offenders).toEqual([]);
  });

  it('the tag chip palette survives in an always-loaded stylesheet', () => {
    const css = readFileSync(join(ROOT, 'dashboard', 'src', 'styles', 'tags.css'), 'utf-8');
    expect(css).toMatch(/\.task-tag\[data-hue="9"\]/);
    expect(readFileSync(join(ROOT, 'dashboard', 'src', 'App.tsx'), 'utf-8')).toContain("import './styles/tags.css';");
  });

  it('the board context menu no longer hands a task to an agent', () => {
    const src = readFileSync(join(TASKS, 'KanbanBoard.tsx'), 'utf-8');
    expect(src).not.toMatch(/Delegate to Claude|assignToAgent|AssignToAgentComposer|DelegateComposer/);
  });
});
