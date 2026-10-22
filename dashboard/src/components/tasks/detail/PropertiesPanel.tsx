import { useMemo } from 'react';
import type { Task, RiceInput, UpdateTaskInput } from '../../../hooks/useTasks';
import { useTaskMembers, useFeatureOptions, useSyncStatus, useTaskOverrides, useStatusModel } from '../../../hooks/useTasks';
import { useObjectives } from '../../../hooks/useObjectives';
import { usePlanningVersions } from '../../../hooks/useVersions';
import { useTaxonomy } from '../../../hooks/useTaxonomy';
import { useI18n } from '../../../context/I18nContext';
import { tagHue } from '../../../lib/tagColor';
import { SearchableSelect } from '../SearchableSelect';
import { TaskCustomFields } from '../TaskCustomFields';
import { AddCustomFieldForm } from '../AddCustomFieldForm';
import { TaskField } from './TaskSection';
import { TaskDateField } from './TaskDateField';
import { RiceField } from './RiceField';
import { useSectionCollapse, type SectionId } from './useSectionCollapse';

export type Updates = UpdateTaskInput['updates'];

interface PropertiesPanelProps {
  task: Task;
  allTasks: Task[];
  /** Every edit goes through the task PATCH, via the drawer shell. */
  update: (updates: Updates, onError?: (err: Error) => void) => void;
  onDelete: () => void;
  deleting: boolean;
  /** The parent select's refusal (the server's parent_task code), shown under it. */
  parentError: string | null;
  setParentError: (msg: string | null) => void;
}

const PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;

/**
 * The drawer's right column (approved v5). Status, Priority, Versions & Sprints and Feature are
 * always visible. "More" (closed by default, remembered per user) holds Prioritization (Urgency,
 * RICE, Objectives), Plan (Start, Due, Parent task, Assignees, Tags, Summary), Custom fields and
 * System (Created, Updated, ID, Delete task).
 */
export function PropertiesPanel({ task, allTasks, update, onDelete, deleting, parentError, setParentError }: PropertiesPanelProps) {
  const { t } = useI18n();
  const sm = useStatusModel();
  const sections = useSectionCollapse();
  const { data: members } = useTaskMembers();
  const { data: syncStatus } = useSyncStatus();
  // On a remote backend an assignee MUST resolve to a real member to round-trip; while
  // sync-status loads, default to the SAFE state (remote) so free text never opens early.
  const remoteBacked = syncStatus === undefined ? true : syncStatus.backend !== 'local';
  const { data: featureOptions } = useFeatureOptions();
  const { data: customFieldDefs } = useTaskOverrides();
  const { data: taxonomy } = useTaxonomy();
  const { data: versions } = usePlanningVersions();
  const { data: objectives = [] } = useObjectives();

  const isBacklog = task.tags.some((x) => x.toLowerCase() === 'backlog');
  const setTags = (tags: string[]) => {
    const u: Updates = { tags };
    // Removing the person tag that backed a legacy `assignee` retires that field too.
    if (task.assignee) {
      const personTag = `person:${task.assignee}`;
      if (task.tags.includes(personTag) && !tags.includes(personTag)) u.assignee = null;
    }
    update(u);
  };
  const removeBacklogTag = () => setTags(task.tags.filter((x) => x.toLowerCase() !== 'backlog'));

  // Assignees are person:<slug> tags (synced to ClickUp as tags); a legacy `assignee` still reads.
  const effectiveAssignees = (() => {
    const set = new Set(task.tags.filter((x) => x.startsWith('person:')).map((x) => x.slice('person:'.length)));
    if (task.assignee) set.add(task.assignee);
    return [...set];
  })();
  const setAssignees = (people: string[]) => {
    const u: Updates = { tags: [...task.tags.filter((x) => !x.startsWith('person:')), ...people.map((p) => `person:${p}`)] };
    if (task.assignee) u.assignee = null;
    update(u);
  };

  const taskObjectives = task.objectives ?? [];
  const setObjectives = (slugs: string[]) => update({ objectives: slugs });

  const tagOptions = useMemo(() => {
    const usage = taxonomy?.usage ?? {};
    const vocab = taxonomy?.vocabulary;
    const known = new Set<string>([
      ...Object.keys(usage),
      ...(vocab ? Object.values(vocab.facetTags).flat() : []),
      ...(vocab?.bareTags ?? []),
    ]);
    const mine = new Set(task.tags.map((x) => x.toLowerCase()));
    return [...known]
      .filter((x) => x && !mine.has(x.toLowerCase()))
      .sort((a, b) => (usage[b] ?? 0) - (usage[a] ?? 0) || a.localeCompare(b))
      .map((x) => ({ value: x, label: x, hint: usage[x] ? `${usage[x]}` : undefined }));
  }, [taxonomy, task.tags]);

  // A parent must be a top-level task other than this one; a task with subtasks cannot get one.
  const hasChildren = allTasks.some((x) => x.parent_task === task.slug);
  const parentOptions = allTasks
    .filter((x) => x.slug !== task.slug && (!x.parent_task || !allTasks.some((p) => p.slug === x.parent_task)))
    .map((x) => ({ value: x.slug, label: x.name || x.slug, hint: x.slug }));

  const customCount = customFieldDefs?.length ?? 0;
  const moreOpen = sections.isOpen('more');
  const group = (id: SectionId, title: string, children: React.ReactNode, extra?: React.ReactNode) => (
    <div className="props-group" key={id}>
      <div className="props-group-head">
        <span className="props-group-title">{title}</span>
        {extra}
      </div>
      {children}
    </div>
  );

  return (
    <aside className="props-col" aria-label="Properties">
      <div className="props-group props-group--first">
        <div className="props-group-head"><span className="props-group-title">Properties</span></div>
        <TaskField label="Status" htmlFor="tf-status">
          <select id="tf-status" className="field-select prop-select" value={task.status} onChange={(e) => update({ status: e.target.value })}>
            {/* The task's OWN status is always offered, even before the status set loads or when
                it names a status this machine does not declare: a controlled <select> with no
                matching option renders blank. */}
            {(sm.order.includes(task.status) ? sm.order : [...sm.order, task.status]).map((k) => (
              <option key={k} value={k}>{['todo', 'in_progress', 'in_review', 'completed'].includes(k) ? t(`tasks.${k}`) : sm.labelOf(k)}</option>
            ))}
          </select>
        </TaskField>
        <TaskField label={t('tasks.priority')} htmlFor="tf-priority">
          <select id="tf-priority" className="field-select prop-select" value={task.priority} onChange={(e) => update({ priority: e.target.value as Task['priority'] })}>
            {PRIORITIES.map((p) => <option key={p} value={p}>{t(`priority.${p}`)}</option>)}
          </select>
        </TaskField>
        <TaskField label="Versions & Sprints" htmlFor="tf-version">
          <select id="tf-version" className="field-select prop-select" value={task.version ?? ''} onChange={(e) => update({ version: e.target.value || null })}>
            <option value="">No version</option>
            <option value="backlog">Backlog</option>
            {(versions ?? []).filter((v) => !/^backlog$/i.test(v.version)).map((v) => <option key={v.version} value={v.version}>{v.version}</option>)}
            {task.version && !/^backlog$/i.test(task.version) && !(versions ?? []).some((v) => v.version === task.version) && (
              <option value={task.version}>{task.version}</option>
            )}
          </select>
        </TaskField>
        <TaskField label="Feature">
          <SearchableSelect
            value={task.related_feature ?? null}
            options={(featureOptions ?? []).map((f) => ({ value: f.slug, label: f.name ?? f.slug, hint: f.name ? f.slug : undefined }))}
            placeholder="No feature"
            searchPlaceholder="Search features…"
            clearLabel="No feature"
            allowCustom
            onChange={(v) => update({ related_feature: (v ?? '').trim() || null })}
          />
        </TaskField>
        <button
          type="button"
          className="props-more"
          data-testid="props-more"
          aria-expanded={moreOpen}
          onClick={() => sections.toggle('more')}
        >
          <span className="props-more-caret" aria-hidden data-open={moreOpen || undefined}>▸</span>
          {moreOpen ? 'Less' : 'More'}
          {!moreOpen && <span className="props-more-summary"> · Urgency, RICE, Objectives, Dates, Parent, Assignee, Tags{customCount ? `, ${customCount} custom` : ''}</span>}
        </button>
      </div>

      {moreOpen && (
        <>
          {group('prioritization', 'Prioritization', (
            <>
              <TaskField label="Urgency" htmlFor="tf-urgency">
                <select id="tf-urgency" className="field-select prop-select" value={task.urgency} onChange={(e) => update({ urgency: e.target.value as Task['urgency'] })}>
                  {PRIORITIES.map((p) => <option key={p} value={p}>{t(`priority.${p}`)}</option>)}
                </select>
              </TaskField>
              <TaskField label={t('rice.title')}>
                <RiceField rice={task.rice} onUpdate={(patch: RiceInput | null) => update({ rice: patch })} />
              </TaskField>
              <TaskField label="Objectives">
                <div className="assignee-multi">
                  {taskObjectives.length > 0 && (
                    <div className="assignee-chips">
                      {taskObjectives.map((slug) => {
                        const o = objectives.find((x) => x.slug === slug);
                        const missing = objectives.length > 0 && !o;
                        return (
                          <span key={slug} className={`assignee-chip${missing ? ' assignee-chip--unmapped' : ''}`} title={missing ? `"${slug}" is not a known objective — remove it or recreate the objective.` : slug}>
                            {o?.title ?? slug}
                            {missing && <span className="assignee-chip__warn" aria-hidden="true">⚠</span>}
                            <button type="button" className="assignee-chip__remove" aria-label={`Remove ${o?.title ?? slug}`} onClick={() => setObjectives(taskObjectives.filter((s) => s !== slug))}>×</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <SearchableSelect
                    value={null}
                    options={objectives.filter((o) => !taskObjectives.includes(o.slug)).map((o) => ({ value: o.slug, label: o.title, hint: o.slug }))}
                    placeholder={taskObjectives.length > 0 ? 'Add objective…' : 'Not on the roadmap'}
                    searchPlaceholder="Search objectives…"
                    clearLabel="None"
                    onChange={(v) => { if (v && !taskObjectives.includes(v)) setObjectives([...taskObjectives, v]); }}
                  />
                </div>
              </TaskField>
            </>
          ))}

          {group('plan', 'Plan', (
            <>
              <TaskDateField label="Start" value={task.start_date} backlog={isBacklog} onChange={(v) => update({ start_date: v || null })} onRemoveBacklog={removeBacklogTag} />
              <TaskDateField label="Due" value={task.due_date} backlog={isBacklog} onChange={(v) => update({ due_date: v || null })} onRemoveBacklog={removeBacklogTag} />
              <TaskField label="Parent task">
                {hasChildren ? (
                  <span className="prop-hint">Has subtasks, so it cannot be a subtask (two levels max).</span>
                ) : (
                  <SearchableSelect
                    value={task.parent_task ?? null}
                    options={parentOptions}
                    placeholder="None"
                    searchPlaceholder="Search tasks…"
                    clearLabel="None"
                    onChange={(v) => {
                      setParentError(null);
                      update({ parent_task: v || null }, (err) => setParentError(err.message));
                    }}
                  />
                )}
                {parentError && <span className="prop-error" role="alert">{parentError}</span>}
              </TaskField>
              <TaskField label="Assignees">
                <div className="assignee-multi">
                  {effectiveAssignees.length > 0 && (
                    <div className="assignee-chips">
                      {effectiveAssignees.map((slug) => {
                        const m = (members ?? []).find((x) => x.slug === slug);
                        const unmapped = remoteBacked && !m;
                        return (
                          <span key={slug} className={`assignee-chip${unmapped ? ' assignee-chip--unmapped' : ''}`} title={unmapped ? `"${slug}" is not a member of this backend — it won't sync. Remove it and pick a real member.` : undefined}>
                            {m?.name ?? slug}
                            {unmapped && <span className="assignee-chip__warn" aria-hidden="true">⚠</span>}
                            {unmapped && <span className="assignee-chip__sr">(not a member — won't sync)</span>}
                            <button type="button" className="assignee-chip__remove" aria-label={`Remove ${m?.name ?? slug}`} onClick={() => setAssignees(effectiveAssignees.filter((p) => p !== slug))}>×</button>
                          </span>
                        );
                      })}
                    </div>
                  )}
                  <SearchableSelect
                    value={null}
                    options={(members ?? []).filter((m) => !effectiveAssignees.includes(m.slug)).map((m) => ({ value: m.slug, label: m.name, hint: m.slug }))}
                    placeholder={effectiveAssignees.length > 0 ? 'Add assignee…' : 'Unassigned'}
                    searchPlaceholder="Search people…"
                    clearLabel="Unassigned"
                    allowCustom={!remoteBacked}
                    onChange={(v) => { const p = (v ?? '').trim(); if (p && !effectiveAssignees.includes(p)) setAssignees([...effectiveAssignees, p]); }}
                  />
                </div>
              </TaskField>
              <TaskField label="Tags">
                <div className="prop-tags prop-tags--editable">
                  {task.tags.map((tag) => (
                    <span key={tag} className="task-tag" data-hue={tagHue(tag)}>
                      {tag}
                      <button type="button" className="task-tag-remove" aria-label={`Remove tag ${tag}`} onClick={() => setTags(task.tags.filter((x) => x !== tag))}>×</button>
                    </span>
                  ))}
                  <div className="task-tag-picker">
                    <SearchableSelect
                      value={null}
                      options={tagOptions}
                      onChange={(v) => { const tag = (v ?? '').trim(); if (tag && !task.tags.some((x) => x.toLowerCase() === tag.toLowerCase())) setTags([...task.tags, tag]); }}
                      allowCustom
                      hideClear
                      triggerLabel="+ tag"
                      searchPlaceholder="Search or create…"
                    />
                  </div>
                </div>
              </TaskField>
              {/* One click for the state the owner uses. Writing only the tag keeps the backend's
                  "backlog ⇒ undated" rule the single definition of what backlog means. */}
              {!isBacklog && (
                <TaskField label="Backlog">
                  <button type="button" className="prop-backlog-send" onClick={() => setTags([...task.tags, 'backlog'])}>Send to backlog</button>
                </TaskField>
              )}
              <TaskField label="Summary" htmlFor="tf-summary">
                <textarea
                  id="tf-summary"
                  className="prop-text-input prop-textarea"
                  defaultValue={task.description}
                  key={`desc-${task.slug}-${task.description}`}
                  placeholder="Short summary of the task"
                  rows={3}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== task.description) update({ description: v }); }}
                />
              </TaskField>
            </>
          ))}

          {group('custom', t('tasks.customFields.sectionLabel'), (
            <div className="custom-fields-cell">
              <TaskCustomFields defs={customFieldDefs ?? []} values={task.custom_fields} onCommit={(key, value) => update({ custom_fields: { [key]: value } })} />
              <AddCustomFieldForm triggerLabel="+ Add field" scopeHint="Adds this field to every task in this project" />
            </div>
          ))}

          {group('system', 'System', (
            <>
              <TaskField label="Created"><span className="prop-date">{task.created_at}</span></TaskField>
              <TaskField label="Updated"><span className="prop-date">{task.updated_at}</span></TaskField>
              <TaskField label="ID"><code className="prop-id">{task.id}</code></TaskField>
              <div className="props-danger">
                <button type="button" className="btn btn--danger-ghost" data-testid="task-delete" onClick={onDelete} disabled={deleting}>
                  {deleting ? 'Deleting…' : 'Delete task'}
                </button>
                <span className="detail-danger-hint">Removes the task locally and on the remote backend (next sync). Its subtasks stay, as top-level tasks.</span>
              </div>
            </>
          ))}
        </>
      )}
    </aside>
  );
}
