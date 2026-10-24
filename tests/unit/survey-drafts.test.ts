/**
 * A question card's picks outlive the card (chat/surveyDrafts.ts): a reattach that re-sends
 * the same ask, or a phone returning to the chat, remounts the card and the picks come back.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  SURVEY_DRAFT_CAP, clearSurveyDraftsForTests, dropSettledSurveyDrafts, dropSurveyDraft, dropSurveyDraftsFor,
  markSurveyDraftSent, readSurveyDraft, surveyDraftKey, surveyDraftOwner, writeSurveyDraft,
} from '../../dashboard/src/components/sleepy/chat/surveyDrafts';

const Q = ['Which colour?', 'Which size?', 'Anything else?'];
const pick = (chosen: string[], text = '') => ({ chosen, text });

beforeEach(() => clearSurveyDraftsForTests());

describe('survey drafts', () => {
  it('write, read, drop', () => {
    const k = surveyDraftKey('conv-1', 'req-1');
    expect(readSurveyDraft(k, Q)).toBeNull();
    writeSurveyDraft(k, { 'Which colour?': pick(['Blue'], 'darker') }, 1);
    expect(readSurveyDraft(k, Q)).toEqual({ picks: { 'Which colour?': pick(['Blue'], 'darker') }, page: 1 });
    dropSurveyDraft(k);
    expect(readSurveyDraft(k, Q)).toBeNull();
  });

  it('keys are per conversation AND request, and split back', () => {
    const a = surveyDraftKey('conv-1', 'req-1');
    expect(a).not.toBe(surveyDraftKey('conv-2', 'req-1'));
    expect(surveyDraftOwner(a)).toEqual({ claudeId: 'conv-1', requestId: 'req-1' });
  });

  it('clamps the page and drops picks for questions that are gone', () => {
    const k = surveyDraftKey('c', 'r');
    writeSurveyDraft(k, { 'Which colour?': pick(['Red']), 'Removed question': pick(['x']) }, 7);
    expect(readSurveyDraft(k, Q.slice(0, 2))).toEqual({ picks: { 'Which colour?': pick(['Red']) }, page: 1 });
    expect(readSurveyDraft(k, [])?.page).toBe(0);
  });

  it('a sent answer is only MARKED, and the mark survives a later write', () => {
    const k = surveyDraftKey('c', 'r');
    writeSurveyDraft(k, { 'Which colour?': pick(['Red']) }, 0);
    markSurveyDraftSent(k, 1234);
    expect(readSurveyDraft(k, Q)?.sentAt).toBe(1234);
    writeSurveyDraft(k, { 'Which colour?': pick(['Green']) }, 0);
    expect(readSurveyDraft(k, Q)).toEqual({ picks: { 'Which colour?': pick(['Green']) }, page: 0, sentAt: 1234 });
  });

  it('a result drops only the drafts whose request is no longer open, in that conversation', () => {
    writeSurveyDraft(surveyDraftKey('c', 'open'), {}, 0);
    writeSurveyDraft(surveyDraftKey('c', 'answered'), {}, 0);
    writeSurveyDraft(surveyDraftKey('other', 'answered'), {}, 0);
    dropSettledSurveyDrafts('c', ['open']);
    expect(readSurveyDraft(surveyDraftKey('c', 'open'), Q)).not.toBeNull();
    expect(readSurveyDraft(surveyDraftKey('c', 'answered'), Q)).toBeNull();
    expect(readSurveyDraft(surveyDraftKey('other', 'answered'), Q)).not.toBeNull();
  });

  it('closing a tab for good drops every draft of that conversation', () => {
    writeSurveyDraft(surveyDraftKey('c', 'a'), {}, 0);
    writeSurveyDraft(surveyDraftKey('c', 'b'), {}, 0);
    writeSurveyDraft(surveyDraftKey('d', 'a'), {}, 0);
    dropSurveyDraftsFor('c');
    expect(readSurveyDraft(surveyDraftKey('c', 'a'), Q)).toBeNull();
    expect(readSurveyDraft(surveyDraftKey('c', 'b'), Q)).toBeNull();
    expect(readSurveyDraft(surveyDraftKey('d', 'a'), Q)).not.toBeNull();
  });

  it(`keeps at most ${SURVEY_DRAFT_CAP}, evicting the least recently written`, () => {
    for (let i = 0; i < SURVEY_DRAFT_CAP; i += 1) writeSurveyDraft(surveyDraftKey('c', `r${i}`), {}, 0);
    writeSurveyDraft(surveyDraftKey('c', 'r0'), {}, 0);   // touched: now the newest
    writeSurveyDraft(surveyDraftKey('c', 'new'), {}, 0);
    expect(readSurveyDraft(surveyDraftKey('c', 'r0'), Q)).not.toBeNull();
    expect(readSurveyDraft(surveyDraftKey('c', 'r1'), Q)).toBeNull();
    expect(readSurveyDraft(surveyDraftKey('c', 'new'), Q)).not.toBeNull();
  });
});
