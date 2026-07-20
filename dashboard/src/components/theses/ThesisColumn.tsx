import type { ThesisView } from '../../hooks/useTheses';
import { STATUS_META } from './thesis-chrome';
import { ThesisCard, type ThesisDisplayProps } from './ThesisCard';
import './ThesisBoard.css';

interface ThesisColumnProps {
  status: string;
  theses: ThesisView[];
  display: ThesisDisplayProps;
  onOpen: (slug: string) => void;
}

export function ThesisColumn({ status, theses, display, onOpen }: ThesisColumnProps) {
  const meta = STATUS_META[status] ?? STATUS_META.draft;
  return (
    <div className="thc-col">
      <div className="thc-col-head">
        <span className="thc-col-dot" style={{ background: meta.colorVar }} />
        <span className="thc-col-label">{meta.label}</span>
        <span className="thc-col-count">{theses.length}</span>
        <div className="thc-col-rule" />
      </div>
      <div className="thc-col-cards">
        {theses.length === 0 && <div className="thc-empty">None</div>}
        {theses.map((t) => (
          <ThesisCard key={t.slug} thesis={t} display={display} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}
