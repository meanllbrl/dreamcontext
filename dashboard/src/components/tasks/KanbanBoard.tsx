import { useState, useMemo, useCallback } from 'react';
import type { Task } from '../../hooks/useTasks';
import { useTasks, useUpdateTask, useSyncStatus, useSyncTasks, useDeleteTask, useTaskMembers } from '../../hooks/useTasks';
import { useVersions } from '../../hooks/useVersions';
import { useProject } from '../../context/ProjectContext';
import { useI18n } from '../../context/I18nContext';
import { useSavedViews, saveView, deleteView, type SavedView } from '../../stores/savedViews';
import { KanbanColumn } from './KanbanColumn';
import { TaskFilters, DEFAULT_FILTERS, type FilterState, type SortField, type GroupBy } from './TaskFilters';
import { TaskCreateModal } from './TaskCreateModal';
import { TaskDetailPanel } from './TaskDetailPanel';
import { EisenhowerMatrix } from './EisenhowerMatrix';
import { RiceScatter } from './RiceScatter';
import { TimelineGantt } from './TimelineGantt';
import { TaskCalendar } from './TaskCalendar';
import { ActivityHeatmap } from './ActivityHeatmap';
import { TaskCard } from './TaskCard';
import { VersionManager } from './VersionManager';
import './KanbanBoard.css';

const PRIORITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const URGENCY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

const STATUS_COLUMNS = [
  { key: 'todo', labelKey: 'tasks.todo', colorVar: '--color-status-todo' },
  { key: 'in_progress', labelKey: 'tasks.in_progress', colorVar: '--color-status-in-progress' },
  { key: 'in_review', labelKey: 'tasks.in_review', colorVar: '--color-status-in-review' },
  { key: 'completed', labelKey: 'tasks.completed', colorVar: '--color-status-completed' },
];

const PRIORITY_COLUMNS = [
  { key: 'critical', label: 'Critical', colorVar: '--color-priority-critical' },
  { key: 'high', label: 'High', colorVar: '--color-priority-high' },
  { key: 'medium', label: 'Medium', colorVar: '--color-priority-medium' },
  { key: 'low', label: 'Low', colorVar: '--color-priority-low' },
];

const URGENCY_COLUMNS = [
  { key: 'critical', label: 'Critical', colorVar: '--color-urgency-critical' },
  { key: 'high', label: 'High', colorVar: '--color-urgency-high' },
  { key: 'medium', label: 'Medium', colorVar: '--color-urgency-medium' },
  { key: 'low', label: 'Low', colorVar: '--color-urgency-low' },
];

function sortTasks(tasks: Task[], field: SortField): Task[] {
  return [...tasks].sort((a, b) => {
    switch (field) {
      case 'updated_at':
      case 'created_at':
        return b[field].localeCompare(a[field]);
      case 'priority':
        return (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
      case 'urgency':
        return (URGENCY_ORDER[a.urgency] ?? 9) - (URGENCY_ORDER[b.urgency] ?? 9);
      case 'name':
        return a.name.localeCompare(b.name);
      case 'rice': {
        // Higher score first; unscored tasks sink to the bottom.
        const sa = a.rice?.score ?? -Infinity;
        const sb = b.rice?.score ?? -Infinity;
        return sb - sa;
      }
    }
  });
}

function applyFilters(tasks: Task[], filters: FilterState): Task[] {
  let result = tasks;

  if (filters.searchQuery.trim()) {
    const q = filters.searchQuery.trim().toLowerCase();
    result = result.filter(t =>
      t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q)
    );
  }

  if (filters.statusFilter.length > 0) {
    result = result.filter(t => filters.statusFilter.includes(t.status));
  }

  if (filters.priorityFilter.length > 0) {
    result = result.filter(t => filters.priorityFilter.includes(t.priority));
  }

  if (filters.urgencyFilter.length > 0) {
    result = result.filter(t => filters.urgencyFilter.includes(t.urgency));
  }

  if (filters.tagFilter.length > 0) {
    result = result.filter(t => t.tags.some(tag => filters.tagFilter.includes(tag)));
  }

  if (filters.versionFilter.length > 0) {
    result = result.filter(t => t.version !== null && filters.versionFilter.includes(t.version));
  }

  if (filters.assigneeFilter.length > 0) {
    result = result.filter(t =>
      t.tags.some(tag => tag.startsWith('person:') && filters.assigneeFilter.includes(tag.slice('person:'.length)))
      || (t.assignee != null && filters.assigneeFilter.includes(t.assignee)),
    );
  }

  if (filters.dateFrom || filters.dateTo) {
    const field = filters.dateField;
    if (filters.dateFrom) {
      result = result.filter(t => t[field].slice(0, 10) >= filters.dateFrom);
    }
    if (filters.dateTo) {
      result = result.filter(t => t[field].slice(0, 10) <= filters.dateTo);
    }
  }

  if (filters.minRice !== null && filters.minRice !== undefined) {
    const min = filters.minRice;
    result = result.filter(t => t.rice?.score !== null && t.rice?.score !== undefined && t.rice.score >= min);
  }

  return sortTasks(result, filters.sortField);
}

/** Migrate old string-based filter values to arrays */
function migrateFilters(raw: unknown): FilterState {
  const f = raw as Record<string, unknown>;
  const migrated = { ...DEFAULT_FILTERS };

  // Copy over compatible fields
  for (const key of Object.keys(DEFAULT_FILTERS) as (keyof FilterState)[]) {
    if (f[key] !== undefined) {
      (migrated as Record<string, unknown>)[key] = f[key];
    }
  }

  // Migrate string -> string[]
  const arrayFields = ['statusFilter', 'priorityFilter', 'urgencyFilter', 'tagFilter', 'versionFilter'] as const;
  for (const field of arrayFields) {
    const val = f[field];
    if (typeof val === 'string') {
      migrated[field] = val.trim() ? [val.trim()] : [];
    } else if (!Array.isArray(val)) {
      migrated[field] = [];
    }
  }

  // Ensure new fields have defaults
  if (migrated.viewMode === undefined) migrated.viewMode = 'kanban';
  if (migrated.subGroupBy === undefined) migrated.subGroupBy = 'none';
  if (migrated.minRice === undefined) migrated.minRice = null;

  return migrated;
}

function getSubGroups(tasks: Task[], subGroupBy: GroupBy): { key: string; label: string; color?: string; tasks: Task[] }[] {
  if (subGroupBy === 'none') return [];

  switch (subGroupBy) {
    case 'status':
      return STATUS_COLUMNS.map(col => ({
        key: col.key,
        label: col.labelKey,
        color: `var(${col.colorVar})`,
        tasks: tasks.filter(t => t.status === col.key),
      })).filter(g => g.tasks.length > 0);
    case 'priority':
      return PRIORITY_COLUMNS.map(col => ({
        key: col.key,
        label: col.label,
        color: `var(${col.colorVar})`,
        tasks: tasks.filter(t => t.priority === col.key),
      })).filter(g => g.tasks.length > 0);
    case 'urgency':
      return URGENCY_COLUMNS.map(col => ({
        key: col.key,
        label: col.label,
        color: `var(${col.colorVar})`,
        tasks: tasks.filter(t => t.urgency === col.key),
      })).filter(g => g.tasks.length > 0);
    case 'tags': {
      const tagMap = new Map<string, Task[]>();
      for (const t of tasks) {
        if (t.tags.length === 0) {
          const arr = tagMap.get('(untagged)') ?? [];
          arr.push(t);
          tagMap.set('(untagged)', arr);
        } else {
          for (const tag of t.tags) {
            const arr = tagMap.get(tag) ?? [];
            arr.push(t);
            tagMap.set(tag, arr);
          }
        }
      }
      return Array.from(tagMap.entries()).map(([key, tasks]) => ({ key, label: key, tasks }));
    }
    case 'version': {
      const verMap = new Map<string, Task[]>();
      for (const t of tasks) {
        const v = t.version ?? '(no version)';
        const arr = verMap.get(v) ?? [];
        arr.push(t);
        verMap.set(v, arr);
      }
      return Array.from(verMap.entries()).map(([key, tasks]) => ({ key, label: key, tasks }));
    }
  }
  return [];
}

function storageKeyFor(projectId: string, key: string): string {
  return projectId ? `dreamcontext:${projectId}:${key}` : `dreamcontext:${key}`;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // quota exceeded or storage disabled
  }
}

export function KanbanBoard() {
  const { t } = useI18n();
  const { projectId } = useProject();
  const { data: tasks, isLoading, isError, error } = useTasks();
  const { data: versions } = useVersions();
  const updateTask = useUpdateTask();
  const { data: syncStatus } = useSyncStatus();
  const { data: members } = useTaskMembers();
  const syncTasks = useSyncTasks();
  const deleteTask = useDeleteTask();

  const isCloud = !!syncStatus && syncStatus.backend !== 'local';
  const assigneeOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const m of members ?? []) if (!seen.has(m.slug)) seen.set(m.slug, m.name || m.slug);
    return [...seen].map(([value, label]) => ({ value, label }));
  }, [members]);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; task: Task } | null>(null);

  const handleTaskContextMenu = (task: Task, e: React.MouseEvent) => {
    e.preventDefault();
    setCtxMenu({ x: e.clientX, y: e.clientY, task });
  };

  const handleCtxDelete = () => {
    if (!ctxMenu) return;
    const target = ctxMenu.task;
    setCtxMenu(null);
    if (!window.confirm(`Delete task "${target.name}"? This propagates to the remote backend on sync.`)) return;
    deleteTask.mutate(target.slug, {
      onSuccess: () => { if (selectedSlug === target.slug) setSelectedSlug(null); },
    });
  };
  const [syncNote, setSyncNote] = useState<string | null>(null);

  const handleSync = () => {
    setSyncNote(null);
    syncTasks.mutate(undefined, {
      onSuccess: ({ report }) => {
        const moved = report.pushed + report.created + report.pulled + report.deleted + report.mirrorDeleted;
        setSyncNote(
          (report as { skipped?: string }).skipped === 'locked'
            ? '⏳ another sync is already running'
            : report.errors.length > 0
            ? `⚠ ${report.errors[0]}`
            : report.conflicts.length > 0
              ? `↕ ${moved} synced · ${report.conflicts.length} conflict(s) preserved`
              : moved > 0
                ? `↕ ${report.pushed + report.created} up · ${report.pulled} down`
                : '✓ up to date',
        );
        setTimeout(() => setSyncNote(null), 6000);
      },
      onError: (err: Error) => {
        setSyncNote(`⚠ ${err.message}`);
        setTimeout(() => setSyncNote(null), 6000);
      },
    });
  };

  const pendingBadge = (syncStatus?.pendingPush ?? 0) + (syncStatus?.queuedOps ?? 0);
  const syncSlot = syncStatus && syncStatus.backend !== 'local' ? (
    <div className="filter-sync-wrap">
      {syncNote && <span className="filter-sync-note">{syncNote}</span>}
      <button
        className="filter-sync-btn"
        onClick={handleSync}
        disabled={syncTasks.isPending}
        title={`Sync with ${syncStatus.backend}`}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className={syncTasks.isPending ? 'filter-sync-spin' : undefined}>
          <path d="M12 7a5 5 0 0 1-9.17 2.75M2 7a5 5 0 0 1 9.17-2.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <path d="M11.5 1.5v3h-3M2.5 12.5v-3h3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {syncTasks.isPending ? 'Syncing…' : 'Sync'}
        {pendingBadge > 0 && !syncTasks.isPending && (
          <span className="filter-sync-badge">{pendingBadge}</span>
        )}
      </button>
    </div>
  ) : undefined;

  const [showCreate, setShowCreate] = useState(false);
  const [showVersionManager, setShowVersionManager] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  // ─── Filters: inline write-through. ProjectProvider gates render on `ready`. ───
  const filtersKey = useMemo(() => storageKeyFor(projectId, 'kanban-filters'), [projectId]);

  const [filters, setFiltersState] = useState<FilterState>(() => {
    const raw = readJson<unknown>(filtersKey, DEFAULT_FILTERS);
    return migrateFilters(raw);
  });

  const setFilters = useCallback((updater: FilterState | ((prev: FilterState) => FilterState)) => {
    setFiltersState(prev => {
      const next = typeof updater === 'function' ? (updater as (p: FilterState) => FilterState)(prev) : updater;
      writeJson(filtersKey, next);
      return next;
    });
  }, [filtersKey]);

  // ─── Saved Views: external store via useSyncExternalStore. ───
  const presets = useSavedViews(projectId);

  const handleFilterChange = useCallback(<K extends keyof FilterState>(key: K, value: FilterState[K]) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  }, [setFilters]);

  const handleClearFilters = useCallback(() => {
    setFilters(prev => ({
      ...DEFAULT_FILTERS,
      sortField: prev.sortField,
      groupBy: prev.groupBy,
      subGroupBy: prev.subGroupBy,
      viewMode: prev.viewMode,
    }));
  }, [setFilters]);

  const handleSavePreset = useCallback((name: string) => {
    saveView(projectId, name, { ...filters });
  }, [filters, projectId]);

  const handleLoadPreset = useCallback((preset: SavedView) => {
    setFilters(migrateFilters(preset.filters));
  }, [setFilters]);

  const handleDeletePreset = useCallback((id: string) => {
    deleteView(projectId, id);
  }, [projectId]);

  const filtered = useMemo(() => {
    return applyFilters(tasks ?? [], filters);
  }, [tasks, filters]);

  const selectedTask = useMemo(() => {
    if (!selectedSlug || !tasks) return null;
    return tasks.find(t => t.slug === selectedSlug) ?? null;
  }, [selectedSlug, tasks]);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks ?? []) {
      for (const tag of t.tags) set.add(tag);
    }
    return Array.from(set).sort();
  }, [tasks]);

  const allVersions = useMemo(() => {
    const set = new Set<string>();
    for (const t of tasks ?? []) {
      if (t.version) set.add(t.version);
    }
    for (const v of versions ?? []) {
      set.add(v.version);
    }
    return Array.from(set).sort();
  }, [tasks, versions]);

  const handleDrop = (slug: string, newValue: string, groupBy: GroupBy) => {
    switch (groupBy) {
      case 'status':
        updateTask.mutate({ slug, updates: { status: newValue as Task['status'] } });
        break;
      case 'priority':
        updateTask.mutate({ slug, updates: { priority: newValue as Task['priority'] } });
        break;
      case 'urgency':
        updateTask.mutate({ slug, updates: { urgency: newValue as Task['urgency'] } });
        break;
      case 'tags':
        // Add the tag to the task if not already present
        {
          const task = (tasks ?? []).find(t => t.slug === slug);
          if (task && !task.tags.includes(newValue) && newValue !== '(untagged)') {
            updateTask.mutate({ slug, updates: { tags: [...task.tags, newValue] } });
          }
        }
        break;
      case 'version':
        updateTask.mutate({ slug, updates: { version: newValue === '(no version)' ? null : newValue } });
        break;
    }
  };

  if (isLoading) {
    return <div className="loading">{t('common.loading')}</div>;
  }
  if (isError) {
    return <div className="error-state">Failed to load tasks. {error?.message}</div>;
  }

  const renderColumns = () => {
    const { groupBy, subGroupBy } = filters;

    const renderColumn = (key: string, label: string, colorVar: string, colTasks: Task[], index: number) => (
      <KanbanColumn
        key={key}
        title={typeof label === 'string' && label.includes('.') ? t(label) : label}
        status={key}
        tasks={colTasks}
        count={colTasks.length}
        colorVar={colorVar}
        onTaskClick={(task) => setSelectedSlug(task.slug)}
        onTaskContextMenu={handleTaskContextMenu}
        onDrop={(slug, newVal) => handleDrop(slug, newVal, groupBy)}
        staggerIndex={index + 1}
        subGroups={subGroupBy !== 'none' ? getSubGroups(colTasks, subGroupBy) : undefined}
      />
    );

    switch (groupBy) {
      case 'status':
        return STATUS_COLUMNS.map((col, i) =>
          renderColumn(col.key, col.labelKey, col.colorVar, filtered.filter(t => t.status === col.key), i),
        );
      case 'priority':
        return PRIORITY_COLUMNS.map((col, i) =>
          renderColumn(col.key, col.label, col.colorVar, filtered.filter(t => t.priority === col.key), i),
        );
      case 'urgency':
        return URGENCY_COLUMNS.map((col, i) =>
          renderColumn(col.key, col.label, col.colorVar, filtered.filter(t => t.urgency === col.key), i),
        );
      case 'tags': {
        const tagMap = new Map<string, Task[]>();
        for (const t of filtered) {
          if (t.tags.length === 0) {
            const arr = tagMap.get('(untagged)') ?? [];
            arr.push(t);
            tagMap.set('(untagged)', arr);
          } else {
            for (const tag of t.tags) {
              const arr = tagMap.get(tag) ?? [];
              arr.push(t);
              tagMap.set(tag, arr);
            }
          }
        }
        return Array.from(tagMap.entries()).map(([tag, tagTasks], i) =>
          renderColumn(tag, tag, '--color-brand-vivid', tagTasks, i),
        );
      }
      case 'version': {
        const openVersions = (versions ?? []).filter(v => v.status === 'planning').map(v => v.version);
        const closedVersions = (versions ?? []).filter(v => v.status === 'released').map(v => v.version);
        const allVers = ['(no version)', ...openVersions, ...closedVersions];
        // Add any versions from tasks not in the versions list
        for (const t of filtered) {
          if (t.version && !allVers.includes(t.version)) allVers.push(t.version);
        }
        return allVers.map((ver, i) => {
          const verTasks = filtered.filter(t => (t.version ?? '(no version)') === ver);
          if (verTasks.length === 0 && ver !== '(no version)') return null;
          return renderColumn(ver, ver, '--color-brand-mid', verTasks, i);
        }).filter(Boolean);
      }
      case 'none':
        return [
          <KanbanColumn
            key="all"
            title="All Tasks"
            status="all"
            tasks={filtered}
            count={filtered.length}
            colorVar="--color-brand-vivid"
            onTaskClick={(task) => setSelectedSlug(task.slug)}
            onTaskContextMenu={handleTaskContextMenu}
            onDrop={() => {}}
            subGroups={subGroupBy !== 'none' ? getSubGroups(filtered, subGroupBy) : undefined}
          />,
        ];
    }
  };

  return (
    <div className="kanban-board">
      <TaskFilters
        filters={filters}
        onFilterChange={handleFilterChange}
        onClearFilters={handleClearFilters}
        onCreateClick={() => setShowCreate(true)}
        presets={presets}
        onSavePreset={handleSavePreset}
        onLoadPreset={handleLoadPreset}
        onDeletePreset={handleDeletePreset}
        allTags={allTags}
        allVersions={allVersions}
        onVersionManagerClick={() => setShowVersionManager(true)}
        syncSlot={syncSlot}
        showAssignee={isCloud}
        assigneeOptions={assigneeOptions}
      />

      {filters.viewMode === 'eisenhower' ? (
        <EisenhowerMatrix
          tasks={filtered}
          onTaskClick={(task) => setSelectedSlug(task.slug)}
          onTaskMove={(slug, updates) => updateTask.mutate({ slug, updates })}
        />
      ) : filters.viewMode === 'scatter' ? (
        <RiceScatter
          tasks={filtered}
          onTaskClick={(task) => setSelectedSlug(task.slug)}
        />
      ) : filters.viewMode === 'list' ? (
        <div className="task-list">
          {filtered.map(task => (
            <TaskCard
              key={task.slug}
              task={task}
              onClick={() => setSelectedSlug(task.slug)}
              onContextMenu={(e) => handleTaskContextMenu(task, e)}
              onDragStart={() => { /* no drag in list view */ }}
            />
          ))}
        </div>
      ) : filters.viewMode === 'timeline' ? (
        <TimelineGantt
          tasks={filtered}
          onTaskClick={(task) => setSelectedSlug(task.slug)}
        />
      ) : filters.viewMode === 'calendar' ? (
        <TaskCalendar
          tasks={filtered}
          onTaskClick={(task) => setSelectedSlug(task.slug)}
        />
      ) : filters.viewMode === 'heatmap' ? (
        <ActivityHeatmap
          tasks={filtered}
          onSelectDay={(_date, dayTasks) => { if (dayTasks.length > 0) setSelectedSlug(dayTasks[0].slug); }}
        />
      ) : (
        <div className="kanban-columns">
          {renderColumns()}
        </div>
      )}

      {showCreate && <TaskCreateModal onClose={() => setShowCreate(false)} />}
      {showVersionManager && <VersionManager onClose={() => setShowVersionManager(false)} tasks={tasks ?? []} />}
      {selectedTask && <TaskDetailPanel task={selectedTask} onClose={() => setSelectedSlug(null)} />}

      {ctxMenu && (
        <div
          className="task-ctx-overlay"
          onClick={() => setCtxMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setCtxMenu(null); }}
        >
          <div
            className="task-ctx-menu"
            style={{
              top: Math.min(ctxMenu.y, window.innerHeight - 100),
              left: Math.min(ctxMenu.x, window.innerWidth - 190),
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="task-ctx-name">{ctxMenu.task.name}</div>
            <button
              type="button"
              className="task-ctx-item"
              onClick={() => { setSelectedSlug(ctxMenu.task.slug); setCtxMenu(null); }}
            >
              Open
            </button>
            <button type="button" className="task-ctx-item task-ctx-item--danger" onClick={handleCtxDelete}>
              Delete task
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
