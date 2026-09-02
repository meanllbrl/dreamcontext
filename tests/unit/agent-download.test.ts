/**
 * Unit tests for the `POST /api/agent/download` pure helpers — the route that writes an
 * export into ~/Downloads so the surface can SAY where it landed (owner report,
 * 2026-09-02: "indiğine dair hiçbir belirteç yok").
 *
 * The two properties worth pinning are both refusals, because this is the one route that
 * writes OUTSIDE the project:
 *   - `safeDownloadName`   — basename-only, and only inert-to-view extensions;
 *   - `uniqueDownloadPath` — never overwrites; numbers a collision like the platform does.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  safeDownloadName, uniqueDownloadPath, downloadsDir, SAVE_EXT, MAX_DOWNLOAD_BYTES,
} from '../../src/server/routes/agent-download.js';

describe('MAX_DOWNLOAD_BYTES', () => {
  it('is the documented 40 MB cap', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(40 * 1024 * 1024);
  });
});

describe('safeDownloadName', () => {
  it('keeps an ordinary export name as-is', () => {
    expect(safeDownloadName('firsat-radari-plan-ozeti.png')).toBe('firsat-radari-plan-ozeti.png');
    expect(safeDownloadName('weekly-report-2026-09-02.html')).toBe('weekly-report-2026-09-02.html');
  });

  it('strips any path, so a name cannot climb out of the downloads folder', () => {
    expect(safeDownloadName('../../.zshrc.png')).toBe('zshrc.png');
    expect(safeDownloadName('/etc/passwd.png')).toBe('passwd.png');
    expect(safeDownloadName('..\\..\\evil.png')).toBe('evil.png');
    expect(safeDownloadName('../..')).toBeNull();
  });

  it('refuses an executable or unknown type — Downloads is a folder people double-click', () => {
    expect(safeDownloadName('install.sh')).toBeNull();
    expect(safeDownloadName('payload.command')).toBeNull();
    expect(safeDownloadName('thing.app')).toBeNull();
    expect(safeDownloadName('report.pkg')).toBeNull();
    expect(safeDownloadName('noext')).toBeNull();
  });

  it('refuses a name with nothing usable left in it', () => {
    expect(safeDownloadName('')).toBeNull();
    expect(safeDownloadName('   ')).toBeNull();
    expect(safeDownloadName('...')).toBeNull();
  });

  it('allows the export formats the surfaces actually produce', () => {
    expect(SAVE_EXT.has('.png')).toBe(true);
    expect(SAVE_EXT.has('.html')).toBe(true);
    expect(SAVE_EXT.has('.sh')).toBe(false);
  });

  it('truncates a name long enough to break a filesystem, keeping the extension', () => {
    const out = safeDownloadName(`${'a'.repeat(400)}.png`);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(120);
    expect(out!.endsWith('.png')).toBe(true);
  });
});

describe('uniqueDownloadPath', () => {
  it('uses the plain name when nothing is in the way', () => {
    expect(uniqueDownloadPath('/d', 'a.png', () => false)).toBe('/d/a.png');
  });

  it('numbers a collision instead of overwriting', () => {
    const taken = new Set(['/d/a.png', '/d/a (1).png']);
    expect(uniqueDownloadPath('/d', 'a.png', (p) => taken.has(p))).toBe('/d/a (2).png');
  });

  it('numbers before the extension, not after it', () => {
    const taken = new Set(['/d/weekly-report.html']);
    expect(uniqueDownloadPath('/d', 'weekly-report.html', (p) => taken.has(p)))
      .toBe('/d/weekly-report (1).html');
  });

  it('gives up rather than looping forever when everything is taken', () => {
    expect(uniqueDownloadPath('/d', 'a.png', () => true)).toBe('/d/a (999).png');
  });
});

describe('downloadsDir', () => {
  it('is <home>/Downloads, created when it is missing', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-dl-'));
    try {
      const dir = downloadsDir(home);
      expect(dir).toBe(join(home, 'Downloads'));
      expect(statSync(dir).isDirectory()).toBe(true);
      // Idempotent: an existing folder is returned, not re-made.
      expect(downloadsDir(home)).toBe(dir);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
