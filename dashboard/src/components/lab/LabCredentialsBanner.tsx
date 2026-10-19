import { useState } from 'react';
import { useLabCredentials, useSetLabCredential } from '../../hooks/useLab';
import { useI18n } from '../../context/I18nContext';

/**
 * Missing-credentials warning banner for the Lab board. Rendered above the
 * toolbar/sections whenever GET /api/lab/credentials reports keys with
 * `present: false`: one row per missing key with the insights that need it and
 * an inline password input + save (POST /api/lab/credentials). Values are
 * write-only — the server never echoes them back, and saved keys drop out of
 * the banner on the query invalidation. Renders nothing when all keys are set.
 */
export function LabCredentialsBanner({ onToast }: { onToast: (msg: string) => void }) {
  const { t } = useI18n();
  const { data: keys } = useLabCredentials();
  const setCredential = useSetLabCredential();
  const [values, setValues] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState(false);

  const missing = (keys ?? []).filter((k) => !k.present);
  if (missing.length === 0) return null;

  const handleSave = (key: string) => {
    const value = values[key] ?? '';
    if (!value.trim()) return;
    setCredential.mutate({ key, value }, {
      onSuccess: () => {
        setValues((prev) => ({ ...prev, [key]: '' }));
        onToast(t('lab.credentials.saved').replace('{key}', key));
      },
      onError: (err) => {
        onToast(t('lab.credentials.saveFailed').replace('{key}', key).replace('{message}', (err as Error).message));
      },
    });
  };

  return (
    <div className="lab-cred-banner" role="alert">
      <div className="lab-cred-banner-header">
        <span className="lab-cred-banner-title">
          {t('lab.credentials.title').replace('{n}', String(missing.length))}
        </span>
        <button
          className="lab-cred-banner-toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          {collapsed ? t('lab.credentials.expand') : t('lab.credentials.collapse')}
        </button>
      </div>
      {!collapsed && (
        <>
          <p className="lab-cred-banner-hint">{t('lab.credentials.hint')}</p>
          <ul className="lab-cred-banner-list">
            {missing.map(({ key, usedBy }) => (
              <li key={key} className="lab-cred-banner-row">
                <div className="lab-cred-banner-key">
                  <code>{key}</code>
                  <span className="lab-cred-banner-usedby">
                    {t('lab.credentials.usedBy').replace('{slugs}', usedBy.join(', '))}
                  </span>
                </div>
                <div className="lab-cred-banner-form">
                  <input
                    type="password"
                    className="lab-cred-banner-input"
                    placeholder={t('lab.credentials.placeholder')}
                    autoComplete="off"
                    value={values[key] ?? ''}
                    onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
                    onKeyDown={(e) => { if (e.key === 'Enter') handleSave(key); }}
                  />
                  <button
                    className="lab-cred-banner-save"
                    onClick={() => handleSave(key)}
                    disabled={setCredential.isPending || !(values[key] ?? '').trim()}
                  >
                    {setCredential.isPending ? t('lab.credentials.saving') : t('lab.credentials.save')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
