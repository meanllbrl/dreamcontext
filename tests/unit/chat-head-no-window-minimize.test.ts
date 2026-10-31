/**
 * Owner 2026-10-31: every tab can be minimized, the chat window cannot. The strip's left corner
 * has no "–" button in either shell, and nothing reserves room for one.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(join(process.cwd(), 'dashboard/src/components/sleepy', p), 'utf-8');

describe('the chat head has no window minimize', () => {
  it('the button, its styles and its clearance are gone', () => {
    for (const f of ['AgentSurface.tsx', 'AgentTerminal.css', 'MobileChat.css', 'super/SuperSurface.css']) {
      expect(read(f)).not.toContain('agent-overlay-collapse');
      expect(read(f)).not.toContain('--head-clear-start');
    }
  });

  it('each tab keeps its own minimize', () => {
    expect(read('AgentSurface.tsx')).toContain('onMinimize={minimizeSession}');
  });
});
