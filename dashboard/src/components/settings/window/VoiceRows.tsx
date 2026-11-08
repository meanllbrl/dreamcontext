import { useCallback, useEffect, useState } from 'react';
import type React from 'react';
import { useI18n } from '../../../context/I18nContext';
import { chordFromEvent, formatHotkey, hotkeyLabel, isLatchKey, parseHotkey } from '../../../lib/voice/hotkey';
import { adoptVoicePrefs } from '../../../lib/voice/voicePrefs';
import { notifyDictationChanged } from '../../../lib/voice/useDictationReady';
import { onReadAloud, readAloudEnabled } from '../../../lib/voice/readAloud';
import { toggleReadAloud, wireReadAloudPersistence } from '../../../lib/voice/readAloudPersist';
import { SettingGroup, SettingRow, Toggle } from '../SettingRow';
import { useDictationState, type ModelId } from '../DictationInstall';
import { DUCKS, LANGUAGES, RATES, SPOKEN, VOICES, type VoiceStatus } from '../VoiceSettings';
import { Seg } from './controls';

/** Voice status and its one writer (`/api/agent/voice/status|config`), as the classic card. */
function useVoice() {
  const [status, setStatus] = useState<VoiceStatus | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    void fetch('/api/agent/voice/status').then(async (res) => {
      if (!res.ok || !live) return;
      const body = await res.json() as VoiceStatus;
      if (!live) return;
      setStatus(body);
      adoptVoicePrefs(body);
    }).catch(() => { /* the rows wait for the truth */ });
    return () => { live = false; };
  }, []);
  const save = useCallback(async (patch: Record<string, unknown>): Promise<boolean> => {
    setSaving(true);
    setError('');
    try {
      const res = await fetch('/api/agent/voice/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null) as { error?: string; message?: string } | null;
        setError(body?.error === 'bad_hotkey' ? (body.message || 'bad_hotkey') : 'save');
        return false;
      }
      const body = await res.json() as VoiceStatus;
      setStatus(body);
      adoptVoicePrefs(body);
      if ('openRouterKey' in patch) notifyDictationChanged();
      return true;
    } catch {
      setError('save');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);
  return { status, saving, error, save };
}

function useReadAloud(): boolean {
  const [on, setOn] = useState(readAloudEnabled);
  useEffect(() => { wireReadAloudPersistence(); return onReadAloud(setOn); }, []);
  return on;
}

/**
 * Settings window → Voice: 8 rows in three cards (owner, 2026-11-01). Speech to text, Read
 * answers aloud, the OpenRouter key. Nothing downloads until an explicit Install; removing the
 * key takes two steps and says what stops.
 */
export function VoiceRows() {
  const { t } = useI18n();
  const { status, saving, error, save } = useVoice();
  const dict = useDictationState();
  const readAloud = useReadAloud();
  const [wantLocal, setWantLocal] = useState(false);
  const [modelPick, setModelPick] = useState<ModelId | ''>('');
  const [capturing, setCapturing] = useState(false);
  const [hotkeyHint, setHotkeyHint] = useState('');
  const [keyMode, setKeyMode] = useState<'' | 'edit' | 'ask'>('');
  const [keyDraft, setKeyDraft] = useState('');
  const [addLang, setAddLang] = useState('');

  const captureHotkey = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') { e.stopPropagation(); setHotkeyHint(''); e.currentTarget.blur(); return; }
    e.preventDefault();
    if (e.key === 'Backspace' || e.key === 'Delete') {
      setHotkeyHint('');
      void save({ pushToTalk: null });
      e.currentTarget.blur();
      return;
    }
    if (['Alt', 'Control', 'Shift', 'Meta'].includes(e.key)) return;
    const chord = chordFromEvent(e.nativeEvent);
    if (!chord) { setHotkeyHint(t('shell.sw.voice.talk.mod')); return; }
    setHotkeyHint('');
    void save({ pushToTalk: formatHotkey(chord) });
    e.currentTarget.blur();
  }, [save, t]);

  if (!status) return null;

  const ds = dict.state;
  const cloud = ds?.choice?.engine === 'cloud';
  const engine: 'local' | 'cloud' = cloud && !wantLocal ? 'cloud' : 'local';
  const localModel = !cloud ? (ds?.choice?.model ?? (ds?.installed ? (ds.model as ModelId | null) : null)) : null;
  const shownModel: ModelId | '' = modelPick || localModel || ds?.recommended || '';
  const chosen = ds?.models.find((m) => m.id === shownModel);
  const needsInstall = !!ds && engine === 'local' && (shownModel !== localModel || !ds.installed);
  const capsLock = isLatchKey(parseHotkey(status.pushToTalk)?.code ?? '');
  const langs = status.sttLanguages ?? [];
  const langName = (id: string) => SPOKEN.find((l) => l.id === id)?.label ?? id;
  const speaking = readAloud && status.speech;

  const dictLine = !ds ? '' : dict.busy
    ? (ds.phase === 'engine' ? t('shell.sw.voice.installing.engine') : t('shell.sw.voice.installing.model').replace('{pct}', ds.total > 0 ? String(Math.min(100, Math.round((ds.received / ds.total) * 100))) : '0'))
    : ds.phase === 'error' && ds.error ? ds.error
      : ds.blocked === 'too_big' ? t('shell.sw.voice.whisper.tooBig').replace('{model}', ds.model ?? '').replace('{gb}', String(ds.machine.memGB))
        : ds.blocked === 'load_failed' ? t('shell.sw.voice.whisper.loadFailed').replace('{model}', ds.model ?? '')
          : '';

  return (
    <>
      <SettingGroup title={t('shell.sw.voice.stt')}>
        <SettingRow
          id="engine"
          title={t('shell.sw.voice.engine')}
          hint={t(engine === 'cloud' ? 'shell.sw.voice.engine.cloud.h' : 'shell.sw.voice.engine.local.h')}
          keywords="dictation whisper speech to text transcription local cloud"
          why={engine === 'cloud' && !status.key ? t('shell.sw.voice.engine.noKey') : dict.postError ?? undefined}
          control={(
            <Seg<'local' | 'cloud'>
              label={t('shell.sw.voice.engine')}
              value={engine}
              disabled={!ds || dict.sending || dict.busy}
              onChange={(v) => {
                if (v === 'cloud') { setWantLocal(false); void dict.choose('cloud'); }
                else setWantLocal(true);
              }}
              options={[{ value: 'local', label: t('shell.sw.voice.engine.local') }, { value: 'cloud', label: 'OpenRouter' }]}
            />
          )}
        />
        {engine === 'local' && ds && (
          <SettingRow
            id="whisper"
            title={t('shell.sw.voice.whisper')}
            hint={dictLine || t('shell.sw.voice.whisper.h').replace('{model}', ds.recommended)}
            keywords="whisper model size download install"
            control={(
              <>
                <select
                  className="settings-text-input"
                  aria-label={t('shell.sw.voice.whisper')}
                  value={shownModel}
                  disabled={dict.busy || dict.sending}
                  onChange={(e) => setModelPick(e.target.value as ModelId)}
                >
                  {ds.models.map((m) => (
                    <option key={m.id} value={m.id} disabled={!m.fits}>
                      {m.id}{m.onDisk ? ` · ${t('shell.sw.voice.whisper.onDisk')}` : ` · ${m.downloadMB >= 1000 ? `${(m.downloadMB / 1000).toFixed(1)} GB` : `${m.downloadMB} MB`}`}{!m.fits ? ` · ${t('shell.sw.voice.whisper.tooLarge')}` : ''}
                    </option>
                  ))}
                </select>
                {needsInstall && !dict.busy && (
                  <button
                    type="button"
                    className="sw-btn sw-btn--accent"
                    disabled={dict.sending || chosen?.fits === false || !shownModel}
                    data-testid="sw-whisper-install"
                    onClick={() => { void dict.choose(shownModel).then(() => { setWantLocal(false); setModelPick(''); }); }}
                  >
                    {chosen?.onDisk && ds.engine ? t('shell.sw.voice.whisper.use').replace('{model}', shownModel) : t('shell.sw.voice.whisper.install').replace('{model}', shownModel)}
                  </button>
                )}
              </>
            )}
          />
        )}
        <SettingRow
          id="ptt"
          title={t('shell.sw.voice.talk')}
          hint={capturing ? t('shell.sw.voice.talk.capturing') : hotkeyHint || t(capsLock || status.pushToTalkMode === 'toggle' ? 'shell.sw.voice.talk.toggle.h' : 'shell.sw.voice.talk.h')}
          keywords="push to talk hotkey key hold toggle shortcut"
          control={(
            <>
              <input
                className="settings-text-input voice-hotkey"
                readOnly
                aria-label={t('shell.sw.voice.talk')}
                value={capturing ? t('shell.sw.voice.talk.press') : hotkeyLabel(status.pushToTalk)}
                disabled={saving}
                onFocus={() => { setCapturing(true); setHotkeyHint(''); }}
                onBlur={() => setCapturing(false)}
                onKeyDown={captureHotkey}
                data-sw-esc
              />
              <Seg<'hold' | 'toggle'>
                label={t('shell.sw.voice.talk.mode')}
                value={capsLock ? 'toggle' : status.pushToTalkMode}
                disabled={saving || capsLock}
                onChange={(v) => { void save({ pushToTalkMode: v }); }}
                options={[{ value: 'hold', label: t('shell.sw.voice.talk.hold') }, { value: 'toggle', label: t('shell.sw.voice.talk.press1') }]}
              />
            </>
          )}
        />
        <SettingRow
          id="langs"
          title={t('shell.sw.voice.langs')}
          hint={t('shell.sw.voice.langs.h')}
          keywords="speech language languages speak detect"
          control={(
            <span className="sw-chips" role="group" aria-label={t('shell.sw.voice.langs')}>
              {langs.map((id) => (
                <span key={id} className="sw-chipx">
                  {langName(id)}
                  <button type="button" aria-label={`${t('shell.sw.remove')} ${langName(id)}`} disabled={saving} onClick={() => { void save({ sttLanguages: langs.filter((x) => x !== id) }); }}>×</button>
                </span>
              ))}
              <select
                className="settings-text-input sw-addlang"
                aria-label={t('shell.sw.voice.langs.add')}
                value={addLang}
                disabled={saving}
                onChange={(e) => { const v = e.target.value; setAddLang(''); if (v) void save({ sttLanguages: [...langs, v] }); }}
              >
                <option value="">＋ {t('shell.sw.voice.langs.add')}</option>
                {SPOKEN.filter((l) => !langs.includes(l.id)).map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </span>
          )}
        >
          <details className="setting-row-more">
            <summary>{t('shell.sw.details')}</summary>
            <label className="sw-inl">
              <span>{t('shell.sw.voice.langs.pin')}</span>
              <select className="settings-text-input" aria-label={t('shell.sw.voice.langs.pin')} value={status.sttLanguage} disabled={saving} onChange={(e) => { void save({ sttLanguage: e.target.value }); }}>
                {LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </select>
            </label>
          </details>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('shell.sw.voice.aloud')}>
        <SettingRow
          id="speakchat"
          title={t('shell.sw.voice.inchat')}
          hint={t('shell.sw.voice.inchat.h')}
          keywords="read aloud speak answers speech tts"
          why={!status.key ? t('shell.sw.voice.needsKey') : undefined}
          control={(
            <Toggle
              label={t('shell.sw.voice.inchat')}
              checked={speaking && status.key}
              disabled={saving || !status.key}
              onChange={(v) => {
                // One machine-wide switch plus the speech preference: on writes both.
                toggleReadAloud(v);
                if (v && !status.speech) void save({ speech: true });
              }}
            />
          )}
        />
        <SettingRow
          id="voicetone"
          title={t('shell.sw.voice.tone')}
          hint={t('shell.sw.voice.tone.h')}
          keywords="voice speed rate timbre music duck pause"
          why={!status.key ? t('shell.sw.voice.needsKey') : undefined}
          control={(
            <>
              <select className="settings-text-input" aria-label={t('shell.sw.voice.tone')} value={status.voice} disabled={saving || !status.key} onChange={(e) => { void save({ voice: e.target.value }); }}>
                {VOICES.map((v) => <option key={v} value={v}>{v.charAt(0).toUpperCase() + v.slice(1)}</option>)}
              </select>
              <select className="settings-text-input" aria-label={t('shell.sw.voice.speed')} value={String(status.speechRate)} disabled={saving || !status.key} onChange={(e) => { void save({ speechRate: Number(e.target.value) }); }}>
                {!RATES.some((r) => r.value === status.speechRate) && <option value={String(status.speechRate)}>{`${status.speechRate}×`}</option>}
                {RATES.map((r) => <option key={r.value} value={String(r.value)}>{`${r.value}×`}</option>)}
              </select>
            </>
          )}
        >
          <details className="setting-row-more">
            <summary>{t('shell.sw.details')}</summary>
            <label className="sw-inl">
              <span>{t('shell.sw.voice.music')}</span>
              <Toggle label={t('shell.sw.voice.music')} checked={status.musicPause} disabled={saving || !status.musicControl} onChange={(v) => { void save({ musicPause: v }); }} />
            </label>
            <label className="sw-inl">
              <span>{t('shell.sw.voice.duck')}</span>
              <select className="settings-text-input" aria-label={t('shell.sw.voice.duck')} value={String(status.musicDuck)} disabled={saving || !status.musicControl} onChange={(e) => { void save({ musicDuck: Number(e.target.value) }); }}>
                {!DUCKS.some((d) => d.value === status.musicDuck) && <option value={String(status.musicDuck)}>{`${Math.round(status.musicDuck * 100)}%`}</option>}
                {DUCKS.map((d) => <option key={d.value} value={String(d.value)}>{d.label}</option>)}
              </select>
            </label>
          </details>
        </SettingRow>
      </SettingGroup>

      <SettingGroup title={t('shell.sw.voice.key')}>
        <SettingRow
          id="orkey"
          title={t(status.key ? 'shell.sw.voice.key.yours' : 'shell.sw.voice.key.none')}
          hint={t(keyMode === 'edit' ? 'shell.sw.voice.key.edit.h' : 'shell.sw.voice.key.h')}
          keywords="api key openrouter remove delete replace add"
          why={keyMode === 'ask' ? t(cloud ? 'shell.sw.voice.key.ask.cloud' : 'shell.sw.voice.key.ask.local') : error ? (error === 'save' ? t('common.error') : error) : undefined}
          control={keyMode === 'edit' ? (
            <>
              <input
                className="settings-text-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                aria-label={t('shell.sw.voice.key')}
                placeholder="sk-or-…"
                value={keyDraft}
                disabled={saving}
                onChange={(e) => setKeyDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && keyDraft.trim()) void save({ openRouterKey: keyDraft.trim() }).then((ok) => { if (ok) { setKeyDraft(''); setKeyMode(''); } });
                }}
              />
              <button type="button" className="sw-btn" onClick={() => { setKeyDraft(''); setKeyMode(''); }}>{t('common.cancel')}</button>
            </>
          ) : keyMode === 'ask' ? (
            <>
              <button type="button" className="sw-btn" onClick={() => setKeyMode('')}>{t('shell.sw.voice.key.keep')}</button>
              <button type="button" className="sw-btn sw-btn--danger" data-testid="sw-key-remove-go" disabled={saving} onClick={() => { void save({ openRouterKey: null }).then((ok) => { if (ok) setKeyMode(''); }); }}>{t('shell.sw.voice.key.removeGo')}</button>
            </>
          ) : status.key ? (
            <>
              <span className="sw-ok">{t('shell.sw.voice.key.connected')}</span>
              <button type="button" className="sw-btn" onClick={() => setKeyMode('edit')}>{t('shell.sw.voice.key.replace')}</button>
              <button type="button" className="sw-btn" data-testid="sw-key-remove" onClick={() => setKeyMode('ask')}>{t('shell.sw.remove')}</button>
            </>
          ) : (
            <button type="button" className="sw-btn sw-btn--accent" onClick={() => setKeyMode('edit')}>{t('shell.sw.voice.key.add')}</button>
          )}
        />
      </SettingGroup>
    </>
  );
}
