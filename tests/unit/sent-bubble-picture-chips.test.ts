/**
 * The sent bubble draws pictures exactly like the composer (owner 2026-10-28: the big thumbnail
 * stack looked ugly with many photos and a long prompt): one inline flow, each picture a chip
 * where it stood, his words continuing after it; the `[Picture N: <path>]` marker never shows.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { pictureRuns, sentPictureLabel } from '../../dashboard/src/components/sleepy/chat/chatEntities.js';
import { refToken } from '../../dashboard/src/components/sleepy/chat/composerRefs.js';
import {
  __resetScratchForTests, composeOutgoing, pendingUploads, readScratch, stagePicked,
} from '../../dashboard/src/components/sleepy/chat/composerScratch.js';
import { quotePath } from '../../dashboard/src/lib/agentComposer.js';

beforeEach(() => { __resetScratchForTests(); });

const copyTo = (dir: string) => async (p: string) => `${dir}/${p.split('/').pop()}`;
const preview = (p: string) => `/api/agent/file?path=${encodeURIComponent(p)}&raw=1`;
const noMarker = (runs: ReturnType<typeof pictureRuns>) =>
  (runs ?? []).every((r) => r.kind !== 'text' || !/\[Picture \d+:/.test(r.text));

/** What the composer sends for picked pictures and a draft `(toks) => draft`. */
async function sendOf(paths: string[], draft: (toks: string[]) => string, quote: string | null = null): Promise<string> {
  stagePicked('c', paths, 'file', copyTo('/v/_dream_context/tmp/agent-drops'), preview);
  await Promise.all(pendingUploads('c'));
  const toks = readScratch('c').attachments.map((a) => refToken({ ...a, chip: a.name }));
  return composeOutgoing(draft(toks), readScratch('c').attachments, quote, quotePath).message;
}

describe('pictureRuns — the sent bubble', () => {
  it('one picture: a chip, then his words on the same line', async () => {
    const sent = await sendOf(['/a/shot.png'], ([t]) => `${t} bu çok karanlık`);
    expect(pictureRuns(sent)).toEqual([
      { kind: 'picture', path: '/v/_dream_context/tmp/agent-drops/shot.png', label: 'shot.png' },
      { kind: 'text', text: ' bu çok karanlık' },
    ]);
  });

  it('four pictures mixed with a long text: one flow, each chip where it stood, no line breaks the send added', async () => {
    const long = 'Bu ekranlarda onboarding akışını baştan sona gözden geçirmeni istiyorum, özellikle';
    const sent = await sendOf(['/a/1.png', '/a/2.png', '/a/3.png', '/a/4.png'],
      (t) => `${long} ${t[0]} burada buton kayıyor ${t[1]} metin uzun ${t[2]} ${t[3]} son ekran tamam`);
    const runs = pictureRuns(sent)!;
    expect(runs.map((r) => (r.kind === 'picture' ? `[${r.label}]` : r.text)).join('')).toBe(
      `${long} [1.png] burada buton kayıyor [2.png] metin uzun [3.png] [4.png] son ekran tamam`,
    );
    expect(runs.filter((r) => r.kind === 'picture')).toHaveLength(4);
    expect(runs.some((r) => r.kind === 'text' && r.text.includes('\n'))).toBe(false);
    expect(noMarker(runs)).toBe(true);
  });

  it('a picture with no comment is just a chip', async () => {
    const sent = await sendOf(['/a/only.png'], ([t]) => t);
    expect(pictureRuns(sent)).toEqual([{ kind: 'picture', path: '/v/_dream_context/tmp/agent-drops/only.png', label: 'only.png' }]);
  });

  it('a quote-reply: the quoted picture line stays quoted text, only this message\'s picture is a chip', async () => {
    const quote = 'look:\n\n[Picture 1: /d/old.png]\ntoo dark';
    const sent = await sendOf(['/a/new.png'], ([t]) => `compress ${t} please`, quote);
    const runs = pictureRuns(sent)!;
    expect(runs.filter((r) => r.kind === 'picture')).toEqual([{ kind: 'picture', path: '/v/_dream_context/tmp/agent-drops/new.png', label: 'new.png' }]);
    expect(runs[0]).toEqual({ kind: 'text', text: '> look:\n\n> [Picture 1: /d/old.png]\ntoo dark\n\ncompress ' });
    expect(runs.at(-1)).toEqual({ kind: 'text', text: ' please' });
  });

  it('his own line breaks inside his words are kept', () => {
    expect(pictureRuns('[Picture 1: /d/a.png]\nbir\niki')).toEqual([
      { kind: 'picture', path: '/d/a.png', label: 'a.png' },
      { kind: 'text', text: ' bir\niki' },
    ]);
  });

  it('text with no picture line is not split', () => {
    expect(pictureRuns('just words')).toBeNull();
  });
});

describe('sentPictureLabel', () => {
  it('drops the drop folder\'s time prefix and clips like the composer chip', () => {
    expect(sentPictureLabel('/v/tmp/agent-drops/1793138805311-Screenshot.png')).toBe('Screenshot.png');
    expect(sentPictureLabel('/v/tmp/agent-drops/1793138805311-a1b2c3-shot.png')).toBe('shot.png');
    expect(sentPictureLabel("/Users/o/Desktop/Screen Shot it's.png")).toBe("Screen Shot it's.png");
    const long = sentPictureLabel('/d/a-very-long-file-name-for-a-picture-2026.png');
    expect(long.endsWith('…')).toBe(true);
    expect([...long].length).toBeLessThanOrEqual(24);
  });
});
