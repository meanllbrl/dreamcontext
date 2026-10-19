import { useState } from 'react';
import { addTodoItem, removeTodoItem, toggleTodoItem } from '../widgetModel';
import { clipTodoItems, todoCapacity } from '../widgetSize';
import { useWbText, useWhiteboardHost } from '../whiteboardHost';
import { WidgetButton, WidgetFrame, WidgetNotice } from './WidgetFrame';
import type { WidgetProps } from './types';

/**
 * A checklist whose state lives in the board file, so an agent reading `whiteboard show --json`
 * sees exactly what the user ticked. Every edit goes through `commitWidget`, which builds the
 * new element with `newElementWith` (the version bumps, so the save and the merge see it) and
 * keeps this widget active in the same `updateScene`, so a second tick lands without a second
 * activating click.
 *
 * Inactive, it shows as many rows as its size holds and says "+N more" for the rest (A17);
 * active, the whole list scrolls, so every item can be ticked.
 */
export function TodoWidget({ elementId, payload, active, size, height }: WidgetProps) {
  const tx = useWbText();
  const host = useWhiteboardHost();
  const [draft, setDraft] = useState('');
  const items = payload.items ?? [];
  const doneCount = items.filter((it) => it.done).length;
  const title = payload.title || tx('whiteboard.kind.todo', 'Todo');
  const { shown, hidden } = active ? { shown: items, hidden: 0 } : clipTodoItems(items, todoCapacity(size, height));

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    host.commitWidget(elementId, (cur) => addTodoItem(cur, text));
    setDraft('');
  };

  return (
    <WidgetFrame
      kind="todo"
      title={items.length ? `${title} · ${doneCount}/${items.length}` : title}
      active={active}
      size={size}
    >
      {items.length === 0 && !active && (
        <WidgetNotice tone="empty">{tx('whiteboard.todo.empty', 'No items yet.')}</WidgetNotice>
      )}
      {items.length > 0 && (
        <ul className="wb-todo-list">
          {shown.map((it) => (
            <li key={it.id} className={`wb-todo-item${it.done ? ' is-done' : ''}`}>
              <label>
                <input
                  type="checkbox"
                  checked={it.done}
                  onChange={() => host.commitWidget(elementId, (cur) => toggleTodoItem(cur, it.id))}
                />
                <span className="wb-todo-text">{it.text}</span>
              </label>
              {active && (
                <button
                  type="button"
                  className="wb-todo-remove"
                  aria-label={tx('whiteboard.todo.remove', 'Remove item')}
                  title={tx('whiteboard.todo.remove', 'Remove item')}
                  onClick={() => host.commitWidget(elementId, (cur) => removeTodoItem(cur, it.id))}
                >
                  ×
                </button>
              )}
            </li>
          ))}
          {hidden > 0 && (
            <li className="wb-todo-more">
              {tx('whiteboard.todo.more', '+{n} more').replace('{n}', String(hidden))}
            </li>
          )}
        </ul>
      )}
      {active && (
        <div className="wb-todo-add">
          <input
            className="wb-input"
            value={draft}
            placeholder={tx('whiteboard.todo.addPlaceholder', 'Add an item')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
          <WidgetButton onClick={add} disabled={!draft.trim()}>{tx('whiteboard.todo.add', 'Add')}</WidgetButton>
        </div>
      )}
    </WidgetFrame>
  );
}
