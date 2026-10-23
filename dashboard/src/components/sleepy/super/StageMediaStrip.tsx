import { useState } from 'react';
import { agentFileUrl } from '../../../api/client';
import { useVault } from '../../../context/VaultContext';
import { useI18n } from '../../../context/I18nContext';

/**
 * The pictures the Super Agent opened on the Mac's stage, as a hands-free phone sees them (task
 * hands-free-phone-shows-every-picture…, D2). The phone has no stage, so an image card the Super
 * opens there arrives as a `stage_media` frame and is drawn here: one line saying so, then the
 * pictures as a row of thumbnails. A tap opens one full size (the chat's own lightbox).
 *
 * The refs are project-relative by `super open`'s contract, so they load through the ordinary
 * inside-project rule of `GET /api/agent/file`; a picture that has gone since degrades to its
 * name, never a broken image icon.
 */
export function StageMediaStrip({ items, onOpenFile }: {
  items: ReadonlyArray<{ ref: string; title?: string }>;
  onOpenFile?: (path: string) => void;
}) {
  const { t } = useI18n();
  const head = items.length === 1 ? t('chat.stageMedia.one') : t('chat.stageMedia.many').replace('{n}', String(items.length));
  return (
    <div className="super-stage-media" role="group" aria-label={head} data-testid="stage-media-strip">
      <div className="super-stage-media-head">
        <span className="super-event-chip-mark" aria-hidden>◆</span> {head}
      </div>
      <div className="super-stage-media-row">
        {items.map((m) => <StageThumb key={m.ref} item={m} onOpenFile={onOpenFile} />)}
      </div>
    </div>
  );
}

function StageThumb({ item, onOpenFile }: { item: { ref: string; title?: string }; onOpenFile?: (path: string) => void }) {
  const { vault } = useVault();
  const [failed, setFailed] = useState(false);
  const name = item.title || item.ref.split('/').pop() || item.ref;
  if (failed) return <span className="super-stage-media-gone" title={item.ref}><span aria-hidden>🖼</span> {name}</span>;
  return (
    <button type="button" className="super-stage-media-thumb" title={name} onClick={() => onOpenFile?.(item.ref)}>
      <img
        src={agentFileUrl(vault, item.ref, { raw: true })}
        alt={name}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    </button>
  );
}
