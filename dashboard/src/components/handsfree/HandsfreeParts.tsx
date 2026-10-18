import { useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { useI18n } from '../../context/I18nContext';
import { copyPreservingUnicode } from '../../lib/clipboard';
import { fill } from '../../lib/fill';
import './handsfree.css';

/** `t()` is a plain lookup; placeholders are filled at the call site, by the shared helper. */
export { fill };

/** A QR code of the URL, drawn as SVG cells from the module matrix (offline, no markup injected). */
export function HandsfreeQr({ value, label }: { value: string; label: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const n = qr.getModuleCount();
    const dark: Array<[number, number]> = [];
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) dark.push([c, r]);
    return { n, dark };
  }, [value]);
  const quiet = 4;
  const size = cells.n + quiet * 2;
  return (
    <svg className="hf-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} className="hf-qr-bg" />
      {cells.dark.map(([x, y]) => <rect key={`${x}-${y}`} x={x + quiet} y={y + quiet} width={1} height={1} className="hf-qr-cell" />)}
    </svg>
  );
}

export function CopyButton({ text, testId }: { text: string; testId?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="hf-btn"
      data-testid={testId}
      onClick={() => {
        void copyPreservingUnicode(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      {copied ? t('handsfree.copied') : t('handsfree.copy')}
    </button>
  );
}
