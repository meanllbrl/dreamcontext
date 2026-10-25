import type { Page } from '../components/layout/Sidebar';

/** The i18n key of each page's name (the phone's top bar shows it). */
export const PAGE_LABEL_KEY: Record<Page, string> = {
  tasks: 'nav.tasks', roadmap: 'nav.roadmap', hypotheses: 'nav.hypotheses', lab: 'nav.labpage', automations: 'nav.aiTeam',
  agents: 'nav.aiTeam', core: 'nav.core', knowledge: 'nav.knowledge', sleep: 'nav.sleep', brain: 'nav.brain', council: 'nav.council',
  settings: 'nav.settings', packs: 'nav.packs', about: 'nav.about', taxonomy: 'nav.taxonomy', announcements: 'nav.announcements',
  whiteboards: 'nav.whiteboard',
};
