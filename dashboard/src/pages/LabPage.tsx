import { LabBoard } from '../components/lab/LabBoard';
import './LabPage.css';

/**
 * Lab — the analytics-insights dashboard page: curated metrics synced from HTTP
 * APIs or scripts, rendered as number/line/pie/raw cards grouped by
 * manifest-declared `group`. Strictly self-contained; no reach into Roadmap.
 */
export function LabPage() {
  return (
    <div style={{ height: '100%', minHeight: 0 }}>
      <LabBoard />
    </div>
  );
}
