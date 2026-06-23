import { useState } from 'react';
import { useCreateTask, useTaskOverrides } from '../../hooks/useTasks';
import { usePlanningVersions } from '../../hooks/useVersions';
import { useI18n } from '../../context/I18nContext';
import { CustomFieldInput } from './CustomFieldInput';
import './TaskCreateModal.css';

interface TaskCreateModalProps {
  onClose: () => void;
}

export function TaskCreateModal({ onClose }: TaskCreateModalProps) {
  const { t } = useI18n();
  const createTask = useCreateTask();
  const { data: versions } = usePlanningVersions();
  const { data: customFieldDefs } = useTaskOverrides();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState('medium');
  const [urgency, setUrgency] = useState('medium');
  const [tagsInput, setTagsInput] = useState('');
  const [why, setWhy] = useState('');
  const [version, setVersion] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, string | number | null>>({});

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    const tags = tagsInput.split(',').map(t => t.trim()).filter(Boolean);
    const filledFields = Object.fromEntries(
      Object.entries(customFields).filter(([, v]) => v !== null && v !== ''),
    );

    createTask.mutate(
      {
        name: name.trim(), description, priority, tags,
        urgency: urgency !== 'medium' ? urgency : undefined,
        why: why.trim() || undefined,
        version: version || undefined,
        custom_fields: Object.keys(filledFields).length > 0 ? filledFields : undefined,
      },
      { onSuccess: () => onClose() },
    );
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">{t('tasks.create')}</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="modal-body">
          <label className="field">
            <span className="field-label">{t('tasks.name')}</span>
            <input
              className="field-input"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Implement user auth"
              autoFocus
              required
            />
          </label>
          <label className="field">
            <span className="field-label">{t('tasks.description')}</span>
            <textarea
              className="field-textarea"
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What needs to be done?"
              rows={3}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('tasks.priority')}</span>
            <select className="field-select" value={priority} onChange={e => setPriority(e.target.value)}>
              <option value="low">{t('priority.low')}</option>
              <option value="medium">{t('priority.medium')}</option>
              <option value="high">{t('priority.high')}</option>
              <option value="critical">{t('priority.critical')}</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Urgency</span>
            <select className="field-select" value={urgency} onChange={e => setUrgency(e.target.value)}>
              <option value="low">{t('priority.low')}</option>
              <option value="medium">{t('priority.medium')}</option>
              <option value="high">{t('priority.high')}</option>
              <option value="critical">{t('priority.critical')}</option>
            </select>
          </label>
          <label className="field">
            <span className="field-label">Version</span>
            <select className="field-select" value={version} onChange={e => setVersion(e.target.value)}>
              <option value="">No version</option>
              {(versions ?? []).map(v => (
                <option key={v.version} value={v.version}>{v.version}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field-label">Why</span>
            <textarea
              className="field-textarea"
              value={why}
              onChange={e => setWhy(e.target.value)}
              placeholder="Why is this task needed?"
              rows={2}
            />
          </label>
          <label className="field">
            <span className="field-label">{t('tasks.tags')}</span>
            <input
              className="field-input"
              value={tagsInput}
              onChange={e => setTagsInput(e.target.value)}
              placeholder="Comma-separated tags"
            />
          </label>
          {(customFieldDefs ?? []).map(field => (
            <label className="field" key={field.key}>
              <span className="field-label">{field.name}</span>
              <CustomFieldInput
                field={field}
                value={customFields[field.key]}
                onChange={(v) => setCustomFields(prev => ({ ...prev, [field.key]: v }))}
              />
            </label>
          ))}
          <div className="modal-actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>
              {t('tasks.cancel')}
            </button>
            <button type="submit" className="btn btn--primary" disabled={!name.trim() || createTask.isPending}>
              {createTask.isPending ? '...' : t('tasks.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
