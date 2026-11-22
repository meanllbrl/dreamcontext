import type { ButtonHTMLAttributes, ReactNode } from 'react';
import './ChatDrawer.css';

/**
 * The Hidden group's header row, shared by the left drawer and the title bar's project picker so
 * both read the same: a chevron, the eye, "Hidden", how many. `end` is the drawer's summed mark.
 */
export function HiddenGroupToggle({ open, label, count, onToggle, end, ...rest }: {
  open: boolean; label: string; count: number; onToggle: () => void; end?: ReactNode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick' | 'children'>) {
  return (
    <button type="button" aria-expanded={open} {...rest} className={`ns-dr-row ns-dr-hidden-row${rest.className ? ` ${rest.className}` : ''}`} onClick={onToggle}>
      <svg className="ns-dr-ico ns-dr-hidden-chev" viewBox="0 0 16 16" aria-hidden="true"><path d={open ? 'M4 6l4 4 4-4' : 'M6 4l4 4-4 4'} /></svg>
      <svg className="ns-dr-ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.8 8S4 3.8 8 3.8 14.2 8 14.2 8 12 12.2 8 12.2 1.8 8 1.8 8z" /><circle cx="8" cy="8" r="1.9" /><path d="M2.8 13.2L13.2 2.8" /></svg>
      <span className="ns-dr-t">{label}</span>
      <span className="ns-dr-hidden-n">{count}</span>
      {end}
    </button>
  );
}
