import { useState } from 'react';
import { useApi } from '../../context/VaultContext';
import { MaskedSecretInput } from '../core/MaskedSecretInput';
import type { McpOverview, McpOverviewServer } from '../../lib/mcpWire';

/**
 * Add / edit / rename-to-import one MCP server (task mcp-management, Settings).
 *
 * Values never come IN: the overview carries header and env KEY names only, so an edit shows
 * each existing key with an empty masked field that means "keep the stored value" (sent as
 * `keep`), and only what the owner types goes out. A URL or command is likewise retyped on an
 * edit only when it changes (blank = keep).
 */

export type McpFormInitial =
  | { mode: 'add'; scope: 'computer' | 'project' }
  | { mode: 'edit'; scope: 'computer' | 'project'; server: McpOverviewServer }
  | { mode: 'import'; scope: 'computer' | 'project'; importName: string; importSource: string };

interface Pair { key: string; value: string; existing: boolean }

const NAME_RE = /^[a-z0-9_][a-z0-9_-]{0,39}$/;

export function McpServerForm({ initial, onCancel, onSaved }: {
  initial: McpFormInitial;
  onCancel: () => void;
  onSaved: (next: McpOverview, message: string) => void;
}) {
  const api = useApi();
  const editing = initial.mode === 'edit' ? initial.server : null;
  const [name, setName] = useState(editing?.name ?? '');
  const [scope, setScope] = useState<'computer' | 'project'>(initial.scope);
  const [type, setType] = useState<'http' | 'sse' | 'stdio'>(
    editing ? (editing.transport === 'stdio' || editing.transport === '' ? 'stdio' : editing.transport === 'sse' ? 'sse' : 'http') : 'http',
  );
  const [url, setUrl] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [headers, setHeaders] = useState<Pair[]>(() => (editing?.headerKeys ?? []).map((key) => ({ key, value: '', existing: true })));
  const [env, setEnv] = useState<Pair[]>(() => (editing?.envKeys ?? []).map((key) => ({ key, value: '', existing: true })));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const pairs = type === 'stdio' ? env : headers;
  const setPairs = type === 'stdio' ? setEnv : setHeaders;
  const field = type === 'stdio' ? 'env' : 'headers';

  const save = async () => {
    setError('');
    if (initial.mode === 'import') {
      if (!NAME_RE.test(name)) { setError('Use lowercase letters, digits, - and _ (up to 40).'); return; }
      setSaving(true);
      try {
        const next = await api.post<McpOverview>('/agent/mcp/import', { name: initial.importName, source: initial.importSource, as: name, scope });
        onSaved(next, `${initial.importName} imported as ${name}.`);
      } catch (e) { setError((e as Error).message || 'Could not import it.'); }
      finally { setSaving(false); }
      return;
    }
    if (!editing && !NAME_RE.test(name)) { setError('Use lowercase letters, digits, - and _ (up to 40).'); return; }
    const definition: Record<string, unknown> = { type };
    const keep: string[] = [];
    if (type === 'stdio') {
      // Command and arguments are kept or replaced each on its own (a blank field = unchanged).
      if (command.trim()) definition.command = command.trim();
      else if (editing) keep.push('command');
      else { setError('A command is needed.'); return; }
      const list = args.split('\n').map((a) => a.trim()).filter(Boolean);
      if (list.length || !editing) definition.args = list;
      else keep.push('args');
    } else if (url.trim()) {
      definition.url = url.trim();
    } else if (editing) keep.push('url');
    else { setError('A URL is needed.'); return; }
    const map: Record<string, string> = {};
    for (const p of pairs) {
      const k = p.key.trim();
      if (!k) continue;
      if (!p.value && p.existing) { map[k] = ''; keep.push(`${field}.${k}`); continue; }
      map[k] = p.value;
    }
    if (Object.keys(map).length) definition[field] = map;
    setSaving(true);
    try {
      const next = await api.post<McpOverview>('/agent/mcp/server', {
        scope, name, definition, keep,
        ...(editing && scope !== initial.scope ? { from: initial.scope } : {}),
      });
      onSaved(next, `${name} saved ${scope === 'computer' ? 'on this computer — every account gets it in its next chat' : 'for this project, on this computer only'}.`);
    } catch (e) { setError((e as Error).message || 'Could not save it.'); }
    finally { setSaving(false); }
  };

  return (
    <div className="mcpm-form" role="group" aria-label={editing ? `Edit ${editing.name}` : 'Add an MCP server'}>
      <div className="mcpm-form-row">
        <label>
          <span>Name</span>
          <input
            className="settings-input"
            value={initial.mode === 'import' ? name : (editing?.name ?? name)}
            disabled={!!editing}
            placeholder={initial.mode === 'import' ? initial.importName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') : 'posthog'}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label>
          <span>Where</span>
          <select className="settings-input" value={scope} onChange={(e) => setScope(e.target.value as 'computer' | 'project')}>
            <option value="computer">This computer (every project, every account)</option>
            <option value="project">This project (on this computer only)</option>
          </select>
        </label>
        {initial.mode !== 'import' && (
          <label>
            <span>Type</span>
            <select className="settings-input" value={type} onChange={(e) => setType(e.target.value as 'http' | 'sse' | 'stdio')}>
              <option value="http">http</option>
              <option value="sse">sse</option>
              <option value="stdio">stdio (a command)</option>
            </select>
          </label>
        )}
      </div>

      {initial.mode !== 'import' && (type === 'stdio' ? (
        <div className="mcpm-form-row">
          <label className="mcpm-form-wide">
            <span>Command</span>
            <input className="settings-input" value={command} placeholder={editing ? `unchanged (${editing.target})` : 'npx'} onChange={(e) => setCommand(e.target.value)} />
          </label>
          <label className="mcpm-form-wide">
            <span>Arguments, one per line</span>
            <textarea className="settings-input" rows={2} value={args} placeholder={editing ? 'unchanged' : '-y\n@scope/server'} onChange={(e) => setArgs(e.target.value)} />
          </label>
        </div>
      ) : (
        <div className="mcpm-form-row">
          <label className="mcpm-form-wide">
            <span>URL</span>
            <input className="settings-input" value={url} placeholder={editing ? `unchanged (${editing.target})` : 'https://mcp.example.com/mcp'} onChange={(e) => setUrl(e.target.value)} />
          </label>
        </div>
      ))}

      {initial.mode !== 'import' && (
        <div className="mcpm-form-pairs">
          <span className="mcpm-muted">{type === 'stdio' ? 'Environment' : 'Headers'} — values are saved on this computer (0600) and never shown again.</span>
          {pairs.map((p, i) => (
            <div className="mcpm-form-pair" key={i}>
              <input
                className="settings-input"
                value={p.key}
                disabled={p.existing}
                placeholder={type === 'stdio' ? 'API_KEY' : 'Authorization'}
                onChange={(e) => setPairs(pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
              />
              <MaskedSecretInput
                value={p.value}
                placeholder={p.existing ? 'unchanged' : 'value'}
                ariaLabel={`${p.key || 'new'} value`}
                onChange={(v) => setPairs(pairs.map((x, j) => (j === i ? { ...x, value: v } : x)))}
              />
              <button type="button" className="btn btn--ghost btn--sm" aria-label="Remove" onClick={() => setPairs(pairs.filter((_, j) => j !== i))}>✕</button>
            </div>
          ))}
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPairs([...pairs, { key: '', value: '', existing: false }])}>
            + {type === 'stdio' ? 'variable' : 'header'}
          </button>
        </div>
      )}

      {error && <p className="mcpm-error" role="alert">{error}</p>}
      <div className="mcpm-form-foot">
        <button type="button" className="btn btn--secondary btn--sm" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn--primary btn--sm" disabled={saving} onClick={() => { void save(); }}>
          {saving ? 'Saving…' : initial.mode === 'import' ? 'Import' : 'Save'}
        </button>
      </div>
    </div>
  );
}
