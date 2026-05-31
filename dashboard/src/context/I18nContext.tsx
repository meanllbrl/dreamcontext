import { createContext, useContext, useState, type ReactNode } from 'react';

const translations: Record<string, Record<string, string>> = {
  en: {
    'nav.brain': 'Brain',
    'nav.tasks': 'Tasks',
    'nav.core': 'Core Files',
    'nav.knowledge': 'Knowledge',
    'nav.features': 'Features',
    'nav.sleep': 'Sleep State',
    'nav.council': 'Council',
    'nav.settings': 'Settings',
    'nav.packs': 'Packs',
    'council.title': 'Council',
    'council.tab.verdict': 'Verdict',
    'council.tab.matrix': 'Matrix',
    'council.tab.transcript': 'Transcript',
    'council.search.placeholder': 'Search sessions…',
    'council.search.matrix': 'Filter cells by text…',
    'council.search.transcript': 'Search transcript…',
    'council.filter.all': 'All',
    'council.filter.status': 'Status',
    'council.inspector.empty': 'Select a persona or cell to inspect.',
    'council.inspector.selectCell': 'Select a cell in the matrix for round details.',
    'council.verdict.awaitingSynthesis': 'Awaiting synthesis',
    'council.verdict.synthPending': 'The final report will appear here once the synthesizer runs.',
    'council.empty.list': 'No council sessions yet.',
    'council.empty.detail': 'Select a council session from the list.',
    'tasks.title': 'Tasks',
    'tasks.create': 'New Task',
    'tasks.filter': 'Filter',
    'tasks.todo': 'To Do',
    'tasks.in_progress': 'In Progress',
    'tasks.in_review': 'In Review',
    'tasks.completed': 'Completed',
    'tasks.name': 'Task Name',
    'tasks.description': 'Description',
    'tasks.priority': 'Priority',
    'tasks.tags': 'Tags',
    'tasks.save': 'Create Task',
    'tasks.cancel': 'Cancel',
    'tasks.changelog': 'Changelog',
    'tasks.add_entry': 'Add Entry',
    'rice.title': 'RICE',
    'rice.reach': 'Reach',
    'rice.impact': 'Impact',
    'rice.confidence': 'Confidence',
    'rice.effort': 'Effort',
    'rice.score': 'Score',
    'rice.clear': 'Clear RICE',
    'rice.tooltip.reach': 'How many people / sessions / units affected (1–10)',
    'rice.tooltip.impact': 'How much per affected unit (1=minimal, 5=massive)',
    'rice.tooltip.confidence': 'How sure are you? (25, 50, 75, 100)',
    'rice.tooltip.effort': 'Person-weeks (0.5–8 typical, max 52)',
    'rice.empty': 'Not rated',
    'sort.rice': 'RICE score',
    'filter.min_rice': 'Min RICE',
    'priority.critical': 'Critical',
    'priority.high': 'High',
    'priority.medium': 'Medium',
    'priority.low': 'Low',
    'sleep.title': 'Sleep State',
    'sleep.debt': 'Debt',
    'sleep.level': 'Level',
    'sleep.last_sleep': 'Last Sleep',
    'sleep.sessions': 'Sessions',
    'sleep.alert': 'Alert',
    'sleep.drowsy': 'Drowsy',
    'sleep.sleepy': 'Sleepy',
    'sleep.must_sleep': 'Must Sleep',
    'core.title': 'Core Files',
    'knowledge.title': 'Knowledge',
    'knowledge.pin': 'Pin',
    'knowledge.unpin': 'Unpin',
    'knowledge.search': 'Search knowledge...',
    'features.title': 'Features',
    'settings.title': 'Settings',
    'settings.platforms': 'Platforms',
    'settings.packs': 'Skill Packs',
    'settings.save': 'Save',
    'settings.saving': 'Saving...',
    'settings.saved': 'Saved',
    'settings.no_config': 'No configuration file found. Saving will create one with your selections.',
    'settings.platform.claude': 'Claude (Anthropic)',
    'settings.platform.codex': 'Codex (OpenAI)',
    'settings.vaults.title': 'Registered Vaults',
    'settings.vaults.empty': 'No vaults registered.',
    'settings.vaults.note': 'Vaults are managed via the CLI. This is a read-only view.',
    'settings.vaults.current': 'Current',
    'settings.packs.installed': 'Installed',
    'packs.title': 'Skill Packs',
    'packs.section.packs': 'Packs',
    'packs.section.standalone': 'Standalone Skills',
    'update.available': 'Update available',
    'update.title': 'Update Available',
    'update.dismiss': 'Dismiss',
    'common.loading': 'Loading...',
    'common.error': 'Error',
    'common.empty': 'Nothing here yet.',
    'common.close': 'Close',
  },
};

interface I18nContextValue {
  locale: string;
  setLocale: (locale: string) => void;
  t: (key: string) => string;
}

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState('en');

  const t = (key: string): string => {
    return translations[locale]?.[key] ?? key;
  };

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used within I18nProvider');
  return ctx;
}
