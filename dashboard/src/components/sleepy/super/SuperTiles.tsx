import { useI18n } from '../../../context/I18nContext';
import { useTasks } from '../../../hooks/useTasks';
import { useKnowledgeList } from '../../../hooks/useKnowledge';
import { useLabInsight } from '../../../hooks/useLab';
import type { SuperContainer as Container, SuperGroup } from '../../../lib/superTypes';
import { DocumentReader } from '../../appLink/DocumentReader';
import { formatValue } from '../../lab/chartBody';
import { knowledgeTitle } from '../../whiteboard/widgetModel';
import type { SessionStatusKind } from '../agentStatus';
import { StatusRing } from './AgentCard';
import { criteriaProgress } from './tileModel';
import { KIND_GLYPH } from './SuperContainer';

/**
 * The floating tiles that are not a chat (owner decision 2026-10-20, direction "Cam HUD"): one 1:1
 * tile each, the kind's glyph and name on top, then what it is at a glance. Task, note and insight
 * read the same queries the whiteboard widgets do (one shared cache, no request of their own);
 * an image shows the picture; a web page or a whiteboard shows its title and opens LIVE only side
 * by side or presented (a live frame or board in a 160 px tile reads as nothing and costs a lot).
 */
export function KindTile({ container: c, title, viewReady }: { container: Container; title: string; viewReady: boolean }) {
  // A tile's data waits for the hand-over to land, like every card view (motion r9): until then
  // it is its kind and its title, which cost no query and no layout of their own.
  if (!viewReady) return <HeadTile container={c} title={title} />;
  switch (c.kind) {
    case 'task': return <TaskTile container={c} title={title} />;
    case 'knowledge': return <NoteTile container={c} title={title} />;
    case 'insight': return <InsightTile container={c} title={title} />;
    case 'image': return <ImageTile container={c} title={title} viewReady={viewReady} />;
    default: return <PlainTile container={c} title={title} />;
  }
}

function HeadTile({ container: c, title }: { container: Container; title: string }) {
  return (
    <div className="super-tile" data-tile={c.kind} title={title}>
      <TileTop kind={c.kind} />
      <div className="super-tile-title">{title}</div>
    </div>
  );
}

function TileTop({ kind }: { kind: Container['kind'] | 'group' }) {
  const { t } = useI18n();
  return (
    <div className="super-tile-top">
      <span className="super-tile-glyph" aria-hidden>{kind === 'group' ? '▤' : KIND_GLYPH[kind]}</span>
      <span className="super-tile-kind">{t(`super.tile.kind.${kind}`)}</span>
    </div>
  );
}

function TaskTile({ container: c, title }: { container: Container; title: string }) {
  const { t } = useI18n();
  const { data } = useTasks();
  const task = data?.find((x) => x.slug === c.ref);
  const name = task?.name || title;
  const crit = criteriaProgress(task?.acceptance_criteria);
  const summary = task?.description && task.description !== task.name ? task.description : task?.why ?? '';
  return (
    <div className="super-tile" data-tile="task" data-view="ready" title={name}>
      <div className="super-tile-top">
        <span className="super-tile-glyph" aria-hidden>{KIND_GLYPH.task}</span>
        <span className="super-tile-kind">{t('super.tile.kind.task')}</span>
        {task && <span className="super-tile-status-dot" data-status={task.status} title={task.status.replace(/_/g, ' ')} aria-label={task.status.replace(/_/g, ' ')} />}
      </div>
      <div className="super-tile-title">{name}</div>
      {crit.total > 0 ? (
        <>
          <div className="super-tile-progress" data-testid="super-tile-progress">
            <span className="super-tile-bar" aria-hidden><span className="super-tile-bar-fill" style={{ transform: `scaleX(${crit.done / crit.total})` }} /></span>
            <span className="super-tile-progress-text">{crit.done}/{crit.total}</span>
          </div>
          <div className="super-tile-line super-tile-next" data-testid="super-tile-next">
            {crit.next ? `${t('super.tile.task.next')} ${crit.next}` : t('super.tile.task.allDone')}
          </div>
        </>
      ) : (
        <>
          {summary && <div className="super-tile-line">{summary}</div>}
          {task && (
            <div className="super-tile-foot">
              <span className="super-tile-status" data-status={task.status}>{task.status.replace(/_/g, ' ')}</span>
              {task.priority && <span>· {task.priority}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NoteTile({ container: c, title }: { container: Container; title: string }) {
  const { data } = useKnowledgeList();
  const entry = data?.find((e) => e.slug === c.ref);
  const name = entry ? knowledgeTitle(entry) : title;
  return (
    <div className="super-tile" data-tile="knowledge" data-view="ready" title={name}>
      <TileTop kind="knowledge" />
      <div className="super-tile-title">{name}</div>
      {entry?.description && <div className="super-tile-line">{entry.description}</div>}
    </div>
  );
}

function InsightTile({ container: c, title }: { container: Container; title: string }) {
  const { data } = useLabInsight(c.ref);
  const points = data?.cache?.series?.[0]?.points ?? [];
  const latest = data?.cache?.latest ?? points[points.length - 1]?.v ?? null;
  const prev = points.length >= 2 ? points[points.length - 2].v : null;
  const delta = latest !== null && prev !== null ? latest - prev : null;
  const name = c.title || data?.insight.title || title;
  return (
    <div className="super-tile" data-tile="insight" data-view="ready" title={name}>
      <TileTop kind="insight" />
      <div className="super-tile-value">{latest !== null ? formatValue(latest, null) : '–'}</div>
      {delta !== null && (
        <div className="super-tile-delta" data-dir={delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'}>
          {delta > 0 ? '▲' : delta < 0 ? '▼' : '='} {formatValue(Math.abs(delta), null)}
        </div>
      )}
      <div className="super-tile-foot super-tile-foot--name">{name}</div>
    </div>
  );
}

function ImageTile({ container: c, title, viewReady }: { container: Container; title: string; viewReady: boolean }) {
  return (
    <div className="super-tile super-tile--image" data-tile="image" data-view="ready" title={title}>
      {viewReady && <div className="super-tile-picture"><DocumentReader path={c.ref} onOpen={() => { /* read-only */ }} embedded /></div>}
      <TileTop kind="image" />
      <div className="super-tile-caption">{title}</div>
    </div>
  );
}

function PlainTile({ container: c, title }: { container: Container; title: string }) {
  const { t } = useI18n();
  let where = '';
  if (c.kind === 'web') { try { where = new URL(c.ref).host; } catch { where = c.ref; } }
  return (
    <div className="super-tile" data-tile={c.kind} data-view="ready" title={title}>
      <TileTop kind={c.kind} />
      <div className="super-tile-title">{title}</div>
      {where && <div className="super-tile-line super-tile-line--one">{where}</div>}
      <div className="super-tile-foot"><span>{t('super.tile.live')}</span></div>
    </div>
  );
}

export interface GroupMember {
  id: string;
  kind: Container['kind'];
  title: string;
  /** A chat's live state; absent for the other kinds. */
  status?: SessionStatusKind;
}

/** The group's state as one: anyone asking, else anyone working, else at rest. */
export function groupStatus(members: readonly GroupMember[]): SessionStatusKind {
  if (members.some((m) => m.status === 'asking')) return 'asking';
  if (members.some((m) => m.status === 'working')) return 'working';
  return 'saved';
}

/**
 * A group as ONE tile: the deck it stands on is drawn by its frame (`TileSheets`); here its name,
 * how many cards, and its first cards with their state, so a glance says what is inside and
 * whether anything in it works or asks. Opening it shows every card (GroupPanel).
 */
export function GroupTile({ group, members }: { group: Pick<SuperGroup, 'name'>; members: readonly GroupMember[] }) {
  const { t } = useI18n();
  const shown = members.length > 3 ? members.slice(0, 2) : members;
  return (
    <div className="super-tile super-tile--group" data-tile="group" data-kind={groupStatus(members)}>
      <span className="super-tile-corners" aria-hidden />
      <div className="super-tile-top">
        <span className="super-tile-glyph" aria-hidden>▤</span>
        <span className="super-tile-kind">{t('super.tile.kind.group')}</span>
        <span className="super-tile-count">{members.length}</span>
      </div>
      <div className="super-tile-name" title={group.name}>{group.name}</div>
      <ul className="super-tile-members">
        {shown.map((m) => (
          <li key={m.id}>
            {m.status ? <StatusRing kind={m.status} size={12} /> : <span className="super-tile-mini" aria-hidden>{KIND_GLYPH[m.kind]}</span>}
            <span className="super-tile-member">{m.title}</span>
          </li>
        ))}
        {members.length > shown.length && (
          <li className="super-tile-more">{t('super.group.more').replace('{n}', String(members.length - shown.length))}</li>
        )}
      </ul>
    </div>
  );
}

/** The deck under a group's tile: two sheets peeking above it. Outside the clip, behind it. */
export function TileSheets() {
  return (
    <>
      <span className="super-tile-sheet" aria-hidden />
      <span className="super-tile-sheet super-tile-sheet--far" aria-hidden />
    </>
  );
}

/**
 * A task's or a note's own name where a card shows its slug (an agent's `super open task <slug>`
 * carries no title): read from the same lists the tiles read. Anything else keeps its title.
 */
export function ResolvedTitle({ container: c, fallback }: { container: Container; fallback: string }) {
  if (c.kind === 'task') return <TaskName slug={c.ref} fallback={fallback} />;
  if (c.kind === 'knowledge') return <NoteName slug={c.ref} fallback={fallback} />;
  return <span className="super-card-title" title={fallback}>{fallback}</span>;
}

function TaskName({ slug, fallback }: { slug: string; fallback: string }) {
  const { data } = useTasks();
  const name = data?.find((x) => x.slug === slug)?.name || fallback;
  return <span className="super-card-title" title={name}>{name}</span>;
}

function NoteName({ slug, fallback }: { slug: string; fallback: string }) {
  const { data } = useKnowledgeList();
  const entry = data?.find((e) => e.slug === slug);
  const name = entry ? knowledgeTitle(entry) : fallback;
  return <span className="super-card-title" title={name}>{name}</span>;
}

/**
 * Over a task's page side by side (owner 2026-10-20: the card showed a title and two chips over
 * an empty body): where it stands at a glance, its status, priority and how far its criteria
 * are, before the page itself.
 */
export function TaskPageHead({ container: c }: { container: Container }) {
  const { data } = useTasks();
  const task = data?.find((x) => x.slug === c.ref);
  if (!task) return null;
  const crit = criteriaProgress(task.acceptance_criteria);
  return (
    <div className="super-page-head" data-testid="super-task-head">
      <span className="super-page-chip" data-status={task.status}>
        <span className="super-tile-status-dot" data-status={task.status} aria-hidden />
        {task.status.replace(/_/g, ' ')}
      </span>
      {task.priority && <span className="super-page-chip">{task.priority}</span>}
      {crit.total > 0 && (
        <span className="super-page-progress">
          <span className="super-tile-bar" aria-hidden><span className="super-tile-bar-fill" style={{ transform: `scaleX(${crit.done / crit.total})` }} /></span>
          <span className="super-tile-progress-text">{crit.done}/{crit.total}</span>
        </span>
      )}
    </div>
  );
}

