import { AutomationsBoard } from '../components/automations/AutomationsBoard';

/** No `<h1>` — the sidebar already labels the active page (project rule). */
export function AutomationsPage() {
  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      <AutomationsBoard />
    </div>
  );
}
