import { useMemo, useState } from 'react';
import type { TaskDetail } from '../../../hooks/useTasks';
import { useUpdateTask, useTaskMembers, useFeatureOptions, useSyncStatus, useTaskOverrides } from '../../../hooks/useTasks';
import { useObjectives } from '../../../hooks/useObjectives';
import { useTaxonomy } from '../../../hooks/useTaxonomy';
import { useAgents, findAgent } from '../../../hooks/useAgents';
import { useI18n } from '../../../context/I18nContext';
import { tagHue } from '../../../lib/tagColor';
import { SearchableSelect } from '../SearchableSelect';
import { TaskCustomFields } from '../TaskCustomFields';
import { AddCustomFieldForm } from '../AddCustomFieldForm';
import { TaskAgentFace } from '../AssignToAgentComposer';
import { taskAgent } from '../boardModel';
import { tr } from '../../../lib/assignToAgent';
import { TaskSection, TaskField, EmptyField, RequiredField } from '../detail/TaskSection';
import type { SectionCollapse } from '../detail/useSectionCollapse';

type Updates = Parameters<ReturnType<typeof useUpdateTask>['mutate']>[0]['updates'];

/**
 * A nullable date, under the shared field contract. Three DISTINCT states:
 *  - never set → the dashed "＋ Add" affordance (it reveals the input; it never writes today);
 *  - set → the input, with the same × clear every field uses;
 *  - undated by rule (a `backlog` tag) → says so, names the tag, and offers to remove it.
 */
function TaskDateField(
  { label, id, value, backlog, onChange, onRemoveBacklog }:
  {
    label: string;
    id: string;
    value: string | null | undefined;
    backlog: boolean;
    onChange: (v: string) => void;
    onRemoveBacklog: () => void;
  },
) {
  const { t } = useI18n();
  const [revealed, setRevealed] = useState(false);

  if (backlog) {
    return (
      <TaskField label={label}>
        <span className="prop-backlog">
          <span className="prop-backlog-text">{t('taskPage.fields.undatedBacklog')}</span>
          <button type="button" className="prop-backlog-clear" onClick={onRemoveBacklog}>
            {t('taskPage.fields.removeBacklog')}
          </button>
        </span>
      </TaskField>
    );
  }

  if (!value && !revealed) {
    return (
      <TaskField label={label}>
        <EmptyField label={t('taskPage.fields.addDate').replace('{field}', label)} onClick={() => setRevealed(true)} />
      </TaskField>
    );
  }

  return (
    <TaskField label={label} htmlFor={id}>
      <span className="prop-date-edit">
        <input
          id={id}
          type="date"
          className="field-select prop-select"
          autoFocus={revealed && !value}
          value={value ?? ''}
          onChange={e => onChange(e.target.value)}
        />
        {value && (
          <button
            type="button"
            className="prop-clear"
            aria-label={t('taskPage.fields.clearDate').replace('{field}', label)}
            title={t('taskPage.fields.clear')}
            onClick={() => { onChange(''); setRevealed(false); }}
          >
            ×
          </button>
        )}
      </span>
    </TaskField>
  );
}

/**
 * The task's properties, moved from the old task panel: name and summary, dates, the agent and
 * the people on it, feature and roadmap, tags, custom fields, and provenance. Priority, urgency,
 * version and RICE are no longer edited here (decision 3); the fields stay readable on the card.
 */
export function TaskFields({ task, collapse, onError, onGiveToAgent }: {
  task: TaskDetail;
  collapse: SectionCollapse;
  onError: (err: Error) => void;
  onGiveToAgent: () => void;
}) {
  const { t } = useI18n();
  const updateTask = useUpdateTask();
  const { data: members } = useTaskMembers();
  const { data: syncStatus } = useSyncStatus();
  // On a remote backend (ClickUp/GitHub) an assignee MUST resolve to a real member to
  // round-trip, so the picker offers only members and flags a slug that is not one. While
  // sync-status loads, default to the SAFE state (remote): never open free text early.
  const remoteBacked = syncStatus === undefined ? true : syncStatus.backend !== 'local';
  const { data: featureOptions } = useFeatureOptions();
  const { data: customFieldDefs } = useTaskOverrides();
  const { data: taxonomy } = useTaxonomy();
  const { data: objectives = [] } = useObjectives();
  const { data: agents } = useAgents();
  const agentSlug = taskAgent(task);
  const agentName = agentSlug ? findAgent(agents, agentSlug)?.title ?? agentSlug : '';

  const patch = (updates: Updates) => updateTask.mutate({ slug: task.slug, updates }, { onError });
  // Clearing goes through the plain PATCH (`agent: null`): it stops nothing and logs nothing.
  const clearAgent = () => updateTask.mutate(
    { slug: task.slug, updates: { agent: null } },
    { onError: () => onError(new Error(tr(t, 'tasks.unassignAgentFailed', "Couldn't remove the agent. Try again."))) },
  );

  const handleTextField = (field: 'name' | 'description' | 'related_feature', value: string) => {
    const next = field === 'related_feature' ? (value.trim() || null) : value.trim();
    if (field !== 'related_feature' && !next) return; // name/summary must stay non-empty
    patch({ [field]: next });
  };

  // Assignment lives in person:<slug> tags; a legacy single `assignee` field is still honoured
  // as a fallback so old tasks render, and retired in the same PATCH once it is edited.
  const personTagsOf = (tags: string[]): string[] =>
    tags.filter(x => x.startsWith('person:')).map(x => x.slice('person:'.length));
  const withPersonTags = (tags: string[], people: string[]): string[] => {
    const rest = tags.filter(x => !x.startsWith('person:'));
    return [...rest, ...people.map(p => `person:${p}`)];
  };
  const effectiveAssignees = (() => {
    const set = new Set(personTagsOf(task.tags));
    if (task.assignee) set.add(task.assignee);
    return [...set];
  })();
  const setAssignees = (people: string[]) => {
    const updates: Updates = { tags: withPersonTags(task.tags, people) };
    if (task.assignee) updates.assignee = null;
    patch(updates);
  };
  const addAssignee = (value: string) => {
    const person = value.trim();
    if (person && !effectiveAssignees.includes(person)) setAssignees([...effectiveAssignees, person]);
  };
  const removeAssignee = (person: string) => setAssignees(effectiveAssignees.filter(p => p !== person));

  // Roadmap objectives this task serves (many-to-many, local-only).
  const taskObjectives = task.objectives ?? [];
  const setTaskObjectives = (slugs: string[]) => patch({ objectives: slugs });
  const addObjective = (slug: string) => { if (slug && !taskObjectives.includes(slug)) setTaskObjectives([...taskObjectives, slug]); };
  const removeObjective = (slug: string) => setTaskObjectives(taskObjectives.filter(s => s !== slug));

  const handleTagsChange = (tags: string[]) => {
    // person: tags ARE assignments. If the edit removed the person tag that backed a legacy
    // `assignee`, retire that field too, or it ghosts back on the next render.
    const updates: Updates = { tags };
    if (task.assignee) {
      const personTag = `person:${task.assignee}`;
      if (task.tags.includes(personTag) && !tags.includes(personTag)) updates.assignee = null;
    }
    patch(updates);
  };
  const handleAddTag = (raw: string) => {
    const tag = raw.trim();
    if (tag && !task.tags.some(x => x.toLowerCase() === tag.toLowerCase())) handleTagsChange([...task.tags, tag]);
  };

  // The `backlog` tag means "undated by rule"; the cause is shown where it bites.
  const isBacklog = task.tags.some(x => x.toLowerCase() === 'backlog');
  const removeBacklogTag = () => handleTagsChange(task.tags.filter(x => x.toLowerCase() !== 'backlog'));

  /** Every tag the vault already knows, most-used first, minus the ones this task carries. */
  const tagOptions = useMemo(() => {
    const usage = taxonomy?.usage ?? {};
    const vocab = taxonomy?.vocabulary;
    const known = new Set<string>([
      ...Object.keys(usage),
      ...(vocab ? Object.values(vocab.facetTags).flat() : []),
      ...(vocab?.bareTags ?? []),
    ]);
    const mine = new Set(task.tags.map(x => x.toLowerCase()));
    return [...known]
      .filter(x => x && !mine.has(x.toLowerCase()))
      .sort((a, b) => (usage[b] ?? 0) - (usage[a] ?? 0) || a.localeCompare(b))
      .map(x => ({ value: x, label: x, hint: usage[x] ? `${usage[x]}` : undefined }));
  }, [taxonomy, task.tags]);

  const section = (id: Parameters<SectionCollapse['isOpen']>[0]) => ({
    open: collapse.isOpen(id),
    onToggle: () => collapse.toggle(id),
  });

  return (
    <div className="props-block">
      <TaskSection id="identity" title={t('taskPage.fields.identity')} count={2} {...section('identity')}>
        <TaskField label={t('taskPage.fields.name')} htmlFor="tf-name">
          <input
            id="tf-name"
            className="prop-text-input"
            defaultValue={task.name}
            key={`name-${task.slug}-${task.name}`}
            onBlur={e => { if (e.target.value.trim() && e.target.value.trim() !== task.name) handleTextField('name', e.target.value); }}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          />
          {!task.name.trim() && <RequiredField label={t('taskPage.fields.nameRequired')} />}
        </TaskField>
        <TaskField label={t('taskPage.fields.summary')} htmlFor="tf-summary">
          <textarea
            id="tf-summary"
            className="prop-text-input prop-textarea"
            defaultValue={task.description}
            key={`desc-${task.slug}-${task.description}`}
            placeholder={t('taskPage.fields.summaryPlaceholder')}
            rows={3}
            onBlur={e => { if (e.target.value.trim() && e.target.value.trim() !== task.description) handleTextField('description', e.target.value); }}
          />
        </TaskField>
      </TaskSection>

      <TaskSection id="timeline" title={t('taskPage.fields.timeline')} count={2} {...section('timeline')}>
        <TaskDateField
          label={t('taskPage.fields.start')} id="tf-date-start" value={task.start_date} backlog={isBacklog}
          onChange={v => patch({ start_date: v || null })} onRemoveBacklog={removeBacklogTag}
        />
        <TaskDateField
          label={t('taskPage.fields.due')} id="tf-date-due" value={task.due_date} backlog={isBacklog}
          onChange={v => patch({ due_date: v || null })} onRemoveBacklog={removeBacklogTag}
        />
      </TaskSection>

      <TaskSection id="ownership" title={t('taskPage.fields.ownership')} count={4} {...section('ownership')}>
        {/* The agent is NOT an assignee: assignees are people (and sync); the agent is
            local-only and shows as its own face. */}
        <TaskField label={t('tasks.agent')}>
          <div className="task-agent-row">
            {agentSlug && <TaskAgentFace slug={agentSlug} size={24} />}
            {agentSlug && <span className="task-agent-row-name">{agentName}</span>}
            <button type="button" className="task-agent-btn" onClick={onGiveToAgent}>
              {t('giveAgent.open')}
            </button>
            {agentSlug && (
              <button
                type="button"
                className="task-agent-btn"
                onClick={clearAgent}
                disabled={updateTask.isPending}
                aria-label={`${t('tasks.unassignAgent')}: ${agentName}`}
              >
                {t('tasks.unassignAgent')}
              </button>
            )}
          </div>
        </TaskField>

        <TaskField label={t('taskPage.fields.assignees')}>
          <div className="assignee-multi">
            {effectiveAssignees.length > 0 && (
              <div className="assignee-chips">
                {effectiveAssignees.map(slug => {
                  const m = (members ?? []).find(x => x.slug === slug);
                  // On a remote backend, a slug that matches no real member won't sync.
                  const unmapped = remoteBacked && !m;
                  return (
                    <span
                      key={slug}
                      className={`assignee-chip${unmapped ? ' assignee-chip--unmapped' : ''}`}
                      title={unmapped ? t('taskPage.fields.notMember').replace('{slug}', slug) : undefined}
                    >
                      {m?.name ?? slug}
                      {unmapped && <span className="assignee-chip__warn" aria-hidden="true">⚠</span>}
                      {unmapped && <span className="assignee-chip__sr">{t('taskPage.fields.notMemberShort')}</span>}
                      <button
                        type="button"
                        className="assignee-chip__remove"
                        aria-label={t('taskPage.fields.remove').replace('{name}', m?.name ?? slug)}
                        onClick={() => removeAssignee(slug)}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <SearchableSelect
              value={null}
              options={(members ?? [])
                .filter(m => !effectiveAssignees.includes(m.slug))
                .map(m => ({ value: m.slug, label: m.name, hint: m.slug }))}
              placeholder={effectiveAssignees.length > 0 ? t('taskPage.fields.addAssignee') : t('taskPage.fields.unassigned')}
              searchPlaceholder={t('taskPage.fields.searchPeople')}
              clearLabel={t('taskPage.fields.unassigned')}
              allowCustom={!remoteBacked}
              onChange={v => { if (v) addAssignee(v); }}
            />
          </div>
        </TaskField>

        <TaskField label={t('taskPage.fields.feature')}>
          <SearchableSelect
            value={task.related_feature ?? null}
            options={(featureOptions ?? []).map(f => ({ value: f.slug, label: f.name ?? f.slug, hint: f.name ? f.slug : undefined }))}
            placeholder={t('taskPage.fields.noFeature')}
            searchPlaceholder={t('taskPage.fields.searchFeatures')}
            clearLabel={t('taskPage.fields.noFeature')}
            allowCustom
            onChange={v => handleTextField('related_feature', v ?? '')}
          />
        </TaskField>

        <TaskField label={t('taskPage.fields.roadmap')}>
          <div className="assignee-multi">
            {taskObjectives.length > 0 && (
              <div className="assignee-chips">
                {taskObjectives.map(slug => {
                  const o = objectives.find(x => x.slug === slug);
                  // A slug with no matching objective was orphaned (deleted or renamed).
                  const missing = objectives.length > 0 && !o;
                  return (
                    <span
                      key={slug}
                      className={`assignee-chip${missing ? ' assignee-chip--unmapped' : ''}`}
                      title={missing ? t('taskPage.fields.unknownObjective').replace('{slug}', slug) : slug}
                    >
                      {o?.title ?? slug}
                      {missing && <span className="assignee-chip__warn" aria-hidden="true">⚠</span>}
                      <button
                        type="button"
                        className="assignee-chip__remove"
                        aria-label={t('taskPage.fields.remove').replace('{name}', o?.title ?? slug)}
                        onClick={() => removeObjective(slug)}
                      >
                        ×
                      </button>
                    </span>
                  );
                })}
              </div>
            )}
            <SearchableSelect
              value={null}
              options={objectives
                .filter(o => !taskObjectives.includes(o.slug))
                .map(o => ({ value: o.slug, label: o.title, hint: o.slug }))}
              placeholder={taskObjectives.length > 0 ? t('taskPage.fields.addObjective') : t('taskPage.fields.notOnRoadmap')}
              searchPlaceholder={t('taskPage.fields.searchObjectives')}
              clearLabel={t('taskPage.fields.none')}
              onChange={v => { if (v) addObjective(v); }}
            />
          </div>
        </TaskField>
      </TaskSection>

      <TaskSection id="labels" title={t('taskPage.fields.labels')} count={task.tags.length} {...section('labels')}>
        <TaskField label={t('taskPage.fields.tags')}>
          <div className="prop-tags prop-tags--editable">
            {task.tags.map(tag => (
              <span key={tag} className="task-tag" data-hue={tagHue(tag)}>
                {tag}
                <button
                  type="button"
                  className="task-tag-remove"
                  aria-label={t('taskPage.fields.removeTag').replace('{tag}', tag)}
                  onClick={() => handleTagsChange(task.tags.filter(x => x !== tag))}
                >
                  ×
                </button>
              </span>
            ))}
            <div className="task-tag-picker">
              <SearchableSelect
                value={null}
                options={tagOptions}
                onChange={v => { if (v) handleAddTag(v); }}
                allowCustom
                hideClear
                triggerLabel={t('taskPage.fields.addTag')}
                searchPlaceholder={t('taskPage.fields.searchTags')}
              />
            </div>
          </div>
        </TaskField>
      </TaskSection>

      <TaskSection id="custom" title={t('tasks.customFields.sectionLabel')} count={customFieldDefs?.length ?? 0} {...section('custom')}>
        <div className="custom-fields-cell">
          <TaskCustomFields
            defs={customFieldDefs ?? []}
            values={task.custom_fields}
            onCommit={(key, value) => patch({ custom_fields: { [key]: value } })}
          />
          <AddCustomFieldForm />
        </div>
      </TaskSection>

      {/* Provenance: consulted rather than read. */}
      <TaskSection id="system" title={t('taskPage.fields.system')} count={task.parent_task ? 4 : 3} {...section('system')}>
        <TaskField label={t('taskPage.fields.created')}>
          <span className="prop-date">{task.created_at}</span>
        </TaskField>
        <TaskField label={t('taskPage.fields.updated')}>
          <span className="prop-date">{task.updated_at}</span>
        </TaskField>
        {task.parent_task && (
          <TaskField label={t('taskPage.fields.parent')}>
            <span className="prop-text">{task.parent_task}</span>
          </TaskField>
        )}
        <TaskField label={t('taskPage.fields.id')}>
          <code className="prop-id">{task.id}</code>
        </TaskField>
      </TaskSection>
    </div>
  );
}
