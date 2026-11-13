/**
 * The run card's status look (owner-approved mockup, 2026-11-13): the header says what happened and
 * who got it, a failure carries its last line, a finished card has one footer row, and every word
 * exists in English and Turkish. Fictional command (synthetic-fixtures pattern).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';

const { RunStatusHead, RunErrLine, RunFold } = await import('../../dashboard/src/components/sleepy/chat/RunCardLook.js');
const read = (p: string) => readFileSync(new URL(`../../dashboard/src/${p}`, import.meta.url), 'utf-8');
const KEYS = ['theAgent', 'ranFine', 'failedExit', 'failed', 'gotResult', 'gotError', 'gotErrorOnly', 'getsResult', 'output', 'hideOutput'];

describe('run card look', () => {
  it('the header names the outcome and the chat that got it', () => {
    const html = renderToStaticMarkup(createElement(RunStatusHead, { look: 'bad', title: 'Failed · exit 1', sub: 'Release chat got the error' }));
    expect(html).toContain('Failed · exit 1');
    expect(html).toContain('Release chat got the error');
    expect(html).toContain('✕');
    expect(renderToStaticMarkup(createElement(RunStatusHead, { look: 'ok', title: 'a', sub: 'b' }))).toContain('✓');
  });

  it('a failure shows its last line, and the footer holds the command, Output and Run again', () => {
    expect(renderToStaticMarkup(createElement(RunErrLine, { line: 'error: tag v2 not found' }))).toContain('run-card-errline');
    const fold = renderToStaticMarkup(createElement(RunFold, { open: false, onToggle: () => {}, label: 'npm run ship', command: 'CMD', output: 'OUT', again: 'AGAIN' }));
    expect(fold).toMatch(/run-card-fold[\s\S]*▸[\s\S]*CMD[\s\S]*OUT[\s\S]*AGAIN/);
  });

  it('every word is in English and Turkish, with no em dash', () => {
    const i18n = read('context/I18nContext.tsx');
    for (const k of KEYS) {
      expect(i18n.match(new RegExp(`'runCard\\.${k}':`, 'g'))?.length, k).toBe(2);
    }
    expect(i18n.split('\n').filter((l) => l.includes("'runCard.")).join('\n')).not.toContain('—');
  });

  it('the card keeps its testids and the base title mapping', () => {
    const run = read('components/sleepy/chat/RunCard.tsx');
    for (const id of ['run-card-play', 'run-card-output-toggle', 'run-card-command']) expect(run).toContain(`data-testid="${id}"`);
    expect(run).toMatch(/recordHost && view\.title === 'Ran in chat' \? t\('ownerCard\.ranOnMac'\)/);
  });
});
