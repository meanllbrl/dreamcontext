/**
 * A compaction in the Chat view: the frames the live stream sends, the rows the transcript
 * keeps, and the card both become. Fixtures are trimmed copies of frames captured from CLI
 * 2.1.261 (`claude -p /compact --resume <id> --output-format stream-json --verbose`) and of a
 * real transcript's `compact_boundary` + `isCompactSummary` pair.
 */
import { describe, it, expect } from 'vitest';
import { parseChatLine } from '../../dashboard/src/lib/chatProtocol.js';
import {
  compactSummaryBody, historyChatItem,
} from '../../dashboard/src/components/sleepy/chatSession';
import { parseTranscriptHistory, userPromptOf } from '../../src/lib/transcript-history.js';

const SUMMARY = 'This session is being continued from a previous conversation that ran out of context. '
  + 'The summary below covers the earlier portion of the conversation.\n\nSummary:\n'
  + '1. Primary Request and Intent:\n   Say hi.\n\n'
  + 'If you need specific details from before compaction (like exact code snippets), read the full transcript at: /x.jsonl\n'
  + 'Continue the conversation from where it left off without asking the user any further questions.';

const line = (o: unknown) => JSON.stringify(o);
const jsonl = (rows: unknown[]) => rows.map(line).join('\n') + '\n';

describe('live compaction frames', () => {
  it('status compacting opens the card', () => {
    expect(parseChatLine(line({ type: 'system', subtype: 'status', status: 'compacting', session_id: 's' })))
      .toEqual({ kind: 'compact-start' });
  });

  it('a status ping that is not a compaction stays noise; a failed one says so', () => {
    expect(parseChatLine(line({ type: 'system', subtype: 'status', status: null, compact_result: 'success' })))
      .toEqual({ kind: 'ignored', rawType: 'system:status' });
    expect(parseChatLine(line({ type: 'system', subtype: 'status', status: null, compact_result: 'failed' })))
      .toEqual({ kind: 'compact-failed' });
  });

  it('compact_boundary carries the token drop and trigger', () => {
    expect(parseChatLine(line({
      type: 'system', subtype: 'compact_boundary', session_id: 's',
      compact_metadata: { trigger: 'manual', pre_tokens: 29578, post_tokens: 4358, duration_ms: 11443 },
    }))).toEqual({ kind: 'compact-boundary', trigger: 'manual', preTokens: 29578, postTokens: 4358 });
  });

  it('the synthetic summary user frame becomes compact-summary; other user text stays hidden', () => {
    expect(parseChatLine(line({ type: 'user', isSynthetic: true, message: { role: 'user', content: SUMMARY } })))
      .toEqual({ kind: 'compact-summary', text: SUMMARY });
    expect(parseChatLine(line({ type: 'user', isReplay: true, message: { role: 'user', content: '<local-command-stdout>Compacted </local-command-stdout>' } })))
      .toEqual({ kind: 'ignored', rawType: 'user:non_tool_result' });
    // Not synthetic: a person who pastes the same sentence is not a compaction.
    expect(parseChatLine(line({ type: 'user', message: { role: 'user', content: SUMMARY } })).kind).toBe('ignored');
  });
});

describe('compactSummaryBody', () => {
  it('cuts the preamble and the instructions to the model', () => {
    expect(compactSummaryBody(SUMMARY)).toBe('1. Primary Request and Intent:\n   Say hi.');
  });

  it('leaves a text in another shape whole', () => {
    expect(compactSummaryBody('  just a summary  ')).toBe('just a summary');
  });
});

describe('compaction in the transcript replay', () => {
  const rows = [
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'hi' } },
    {
      type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted', isMeta: false,
      timestamp: '2026-09-11T00:13:17.271Z',
      compactMetadata: { trigger: 'auto', preTokens: 280806, postTokens: 19067 },
    },
    {
      type: 'user', uuid: 'u2', isVisibleInTranscriptOnly: true, isCompactSummary: true,
      timestamp: '2026-09-11T00:13:17.268Z', message: { role: 'user', content: SUMMARY },
    },
    { type: 'user', uuid: 'u3', message: { role: 'user', content: 'devam' } },
  ];

  it('the boundary and its summary become ONE compact item, never a user bubble', () => {
    const items = parseTranscriptHistory(jsonl(rows));
    expect(items.map((i) => i.kind)).toEqual(['user', 'compact', 'user']);
    expect(items[1]).toMatchObject({ kind: 'compact', trigger: 'auto', preTokens: 280806, postTokens: 19067, text: SUMMARY });
    expect(items.some((i) => i.kind === 'user' && i.text?.startsWith('This session'))).toBe(false);
  });

  it('a summary is never what the user said (session titles)', () => {
    expect(userPromptOf(rows[2])).toBe('');
  });

  it('a summary row with no boundary before it still shows', () => {
    const items = parseTranscriptHistory(jsonl([rows[2]]));
    expect(items).toEqual([expect.objectContaining({ kind: 'compact', text: SUMMARY })]);
  });

  it('historyChatItem draws it done, with the trimmed summary', () => {
    expect(historyChatItem({ kind: 'compact', text: SUMMARY, preTokens: 10, postTokens: 2, trigger: 'manual', at: 5 }, 'h1')).toEqual({
      kind: 'compact', id: 'h1', status: 'done', ts: 5, trigger: 'manual', preTokens: 10, postTokens: 2,
      summary: '1. Primary Request and Intent:\n   Say hi.',
    });
  });
});
