/**
 * What one Super stage card becomes in Telegram (plan L2, S1, S2, T1-T5, Q1-Q3, N1).
 *
 * Pictures in v1, only when the caller allows pictures (L1/N3: a Telegram turn or streaming, and
 * no secret card pending in that chat):
 *   - image / video / pdf → the file itself, through the H outbound classifier (fd read);
 *   - insight → `render_card` (window clone, server seal; html/v1 frames rebuilt from the lab
 *     cache) when a renderer is wired, else its title;
 *   - a `web` card on a project file: `.html/.htm` → ONE PDF document of the page as the stage
 *     draws it (`page-pdf.ts`, bytes read through H; owner 2026-11-09); a picture or PDF → the
 *     file; anything else, or a page that could not be printed → "Mac'te açık".
 * Text in v1: whiteboard, board, task, knowledge, agenda, team, chat, member, app/v1 insights,
 * and web / live browser (a public https page as a link line, never a picture).
 */
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { REFUSAL_WHY, readOutbound, type ClassifyOptions, type OutboundRefusal } from '../../lib/telegram/files.js';
import { cleanTitle, webCardLine } from '../../lib/telegram/urls.js';
import { validateSuperWebUrl } from '../../lib/super/web-url.js';
import { readWhiteboard } from '../../lib/whiteboards/store.js';
import { widgetPayloadOf } from '../../lib/whiteboards/widgets.js';
import type { SuperContainer } from '../../lib/super/types.js';
import type { UploadFile } from '../../lib/telegram/transport.js';
import { renderPagePdf, type PagePdfRenderer } from './page-pdf.js';
import { pngFile, type MediaItem, type Snapshotter } from './pictures.js';

export type CardOut =
  | { kind: 'media'; items: MediaItem[]; title: string }
  | { kind: 'text'; line: string; title: string; button?: { text: string; url: string } };

export interface CardContext {
  contextRoot: string;
  /** The Super chat whose window renders pictures. */
  sessionId: string;
  /** L1/N3 and "no picture while a secret card is pending". */
  pictures: boolean;
  tunnelHost?: string | null;
  snapshot: Snapshotter;
  /** `render_card` for an insight container → PNG slices, or null (text). */
  renderInsight?: (containerId: string) => Promise<Buffer[] | null>;
  isGitIgnored?: ClassifyOptions['isGitIgnored'];
  /** A project HTML page → PDF bytes or null (text). Defaults to headless Chromium. */
  renderPdf?: PagePdfRenderer;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm']);
const CONTENT_TYPE: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/mp4', '.webm': 'video/webm', '.pdf': 'application/pdf',
};
const KIND_WORD: Record<string, string> = {
  task: 'Görev', knowledge: 'Bilgi', agenda: 'Gündem', team: 'Ekip işi', chat: 'Sohbet', member: 'Üye',
  insight: 'Insight', board: 'Pano', whiteboard: 'Whiteboard', image: 'Resim', pdf: 'PDF', video: 'Video', web: 'Sayfa', browser: 'Tarayıcı',
};

export function cardTitle(c: Pick<SuperContainer, 'kind' | 'ref' | 'title'>): string {
  return cleanTitle(c.title || c.ref.split('/').pop() || KIND_WORD[c.kind] || c.kind);
}

/** A project-relative or absolute path read through H; the project root and nothing else. */
export function readProjectFile(ctx: Pick<CardContext, 'contextRoot' | 'isGitIgnored'>, ref: string): { ok: true; file: UploadFile; ext: string } | { ok: false; reason: OutboundRefusal } {
  const projectRoot = dirname(ctx.contextRoot);
  const abs = isAbsolute(ref) ? ref : resolve(projectRoot, ref);
  const r = readOutbound(abs, { roots: [projectRoot], projectRoot, maxBytes: 20 * 1024 * 1024, ...(ctx.isGitIgnored ? { isGitIgnored: ctx.isGitIgnored } : {}) });
  if (!r.ok) return { ok: false, reason: r.reason };
  const ext = extname(r.file.name).toLowerCase();
  return { ok: true, file: { name: r.file.name, data: r.file.data, contentType: CONTENT_TYPE[ext] ?? 'application/octet-stream' }, ext };
}

/** Why a picture the stage shows did not go (owner 2026-11-11: never a bare "(Mac'te)"). */
export const NOT_SENT = {
  secret: 'gizli bir kart açıkken resim gönderilmez; kart bitince tekrar iste',
  format: 'bu biçim Telegram\'da açılmıyor, Mac\'te açık',
  refused: 'Telegram kabul etmedi, Mac\'te açık',
} as const;
/** "<Kind>: <title> (gönderilmedi: <why>)". */
export function notSentLine(head: string, title: string, why: string): string {
  return `${head}${title} (gönderilmedi: ${why})`;
}

function fileMedia(file: UploadFile, ext: string, title: string): MediaItem | null {
  if (IMAGE_EXT.has(ext)) return { kind: 'photo', file, title };
  if (VIDEO_EXT.has(ext)) return { kind: 'video', file, title };
  if (ext === '.pdf') return { kind: 'document', file, title };
  return null;
}

/** A project HTML page through H, printed to one PDF document (null → the caller's text line). */
export async function reportPdf(ctx: CardContext, ref: string, title: string): Promise<MediaItem | null> {
  const f = readProjectFile(ctx, ref);
  if (!f.ok || (f.ext !== '.html' && f.ext !== '.htm')) return null;
  const pdf = await (ctx.renderPdf ?? renderPagePdf)(f.file.data.toString('utf8'));
  if (!pdf) return null;
  const name = `${title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'sayfa'}.pdf`;
  return { kind: 'document', file: { name, data: pdf, contentType: 'application/pdf' }, title };
}

function whiteboardLine(ctx: CardContext, c: SuperContainer, title: string): string {
  try {
    const wb = readWhiteboard(ctx.contextRoot, c.ref);
    const live = wb.board.elements.filter((e) => !(e as { isDeleted?: boolean }).isDeleted);
    const notes = live.filter((e) => widgetPayloadOf(e)).length;
    return `Whiteboard: ${title} · ${notes} not, ${live.length - notes} çizim`;
  } catch {
    return `Whiteboard: ${title}`;
  }
}

/** One card, as Telegram gets it. Never throws: anything unexpected is its title line. */
export async function cardOut(ctx: CardContext, c: SuperContainer): Promise<CardOut> {
  const title = cardTitle(c);
  const text = (line: string, button?: { text: string; url: string }): CardOut => ({ kind: 'text', line, title, ...(button ? { button } : {}) });
  try {
    switch (c.kind) {
      case 'image': case 'video': case 'pdf': {
        const head = `${KIND_WORD[c.kind]}: `;
        if (!ctx.pictures) return text(notSentLine(head, title, NOT_SENT.secret));
        const f = readProjectFile(ctx, c.ref);
        if (!f.ok) return text(notSentLine(head, title, REFUSAL_WHY[f.reason]));
        const m = fileMedia(f.file, f.ext, title);
        return m ? { kind: 'media', items: [m], title } : text(notSentLine(head, title, NOT_SENT.format));
      }
      case 'insight': {
        if (ctx.pictures && ctx.renderInsight) {
          const pngs = await ctx.renderInsight(c.id);
          if (pngs?.length) return { kind: 'media', items: pngs.map((p, i) => ({ kind: 'photo' as const, file: pngFile(`${c.ref}-${i + 1}`, p), title })), title };
        }
        return text(`Insight: ${title} (Mac'te)`);
      }
      case 'web': {
        const v = validateSuperWebUrl(c.ref);
        if (v.ok && v.kind === 'file') {
          if (!ctx.pictures) return text(notSentLine('Sayfa: ', title, NOT_SENT.secret));
          const ext = extname(v.href).toLowerCase();
          if (ext === '.html' || ext === '.htm') {
            const doc = await reportPdf(ctx, v.href, title);
            return doc ? { kind: 'media', items: [doc], title } : text(`Mac'te açık: ${title}`);
          }
          const f = readProjectFile(ctx, v.href);
          if (!f.ok) return text(notSentLine('Sayfa: ', title, REFUSAL_WHY[f.reason]));
          const m = fileMedia(f.file, f.ext, title);
          return m ? { kind: 'media', items: [m], title } : text(`Mac'te açık: ${title}`);
        }
        const w = webCardLine(v.ok ? v.href : null, title, ctx.tunnelHost ?? null);
        return text(w.line, w.kind === 'link' && w.href ? { text: `🔗 ${w.host}`.slice(0, 64), url: w.href } : undefined);
      }
      case 'browser':
        // The live browser's address is never read here: "Mac'te açık" (Q3/Q4 null rule).
        return text(webCardLine(null, title, null).line);
      case 'whiteboard':
        return text(whiteboardLine(ctx, c, title));
      case 'board':
        return text(`Pano: ${title} (Mac'te)`);
      default:
        return text(`${KIND_WORD[c.kind] ?? 'Kart'}: ${title}`);
    }
  } catch {
    return text(`${KIND_WORD[c.kind] ?? 'Kart'}: ${title}`);
  }
}

