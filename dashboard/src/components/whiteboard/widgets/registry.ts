import type { ComponentType } from 'react';
import type { WidgetKind } from '../widgetModel';
import { InsightWidget } from './InsightWidget';
import { KnowledgeWidget } from './KnowledgeWidget';
import { TaskWidget } from './TaskWidget';
import { TodoWidget } from './TodoWidget';
import { NoteWidget } from './NoteWidget';
import { HtmlWidget } from './HtmlWidget';
import { WebWidget } from './WebWidget';
import { WikiWidget } from './WikiWidget';
import type { WidgetProps } from './types';

/** One component per widget kind. `Record` over the kind union, so a new kind in the contract
 *  that has no component here fails the type check. */
export const WIDGET_REGISTRY: Record<WidgetKind, ComponentType<WidgetProps>> = {
  insight: InsightWidget,
  knowledge: KnowledgeWidget,
  task: TaskWidget,
  todo: TodoWidget,
  note: NoteWidget,
  html: HtmlWidget,
  web: WebWidget,
  wiki: WikiWidget,
};
