import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateHypothesis, loadHypothesisFile } from '../../src/lib/marketing/hypothesis.js';

describe('marketing/hypothesis', () => {
  let tmp: string;

  beforeEach(() => {
    const raw = join(tmpdir(), `mk-hyp-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(raw, { recursive: true });
    tmp = realpathSync(raw);
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('validateHypothesis', () => {
    it('accepts a valid hypothesis', () => {
      const r = validateHypothesis({
        predicted_winner: 'broad audience + UGC video creative',
        predicted_metric: 'ROAS',
        decision_threshold: 2.0,
        kill_condition: 'spend zero for 3 days',
      });
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    it('rejects when any of the 4 required fields is missing', () => {
      const r = validateHypothesis({
        predicted_winner: 'X',
        predicted_metric: 'ROAS',
        decision_threshold: 2.0,
        // kill_condition missing
      });
      expect(r.valid).toBe(false);
      expect(r.fieldErrors.kill_condition).toBe('missing');
    });

    it('rejects empty predicted_winner', () => {
      const r = validateHypothesis({
        predicted_winner: '',
        predicted_metric: 'ROAS',
        decision_threshold: 2.0,
        kill_condition: 1.0,
      });
      expect(r.valid).toBe(false);
      expect(r.fieldErrors.predicted_winner).toBe('empty');
    });

    it('rejects too-vague predicted_winner', () => {
      const r = validateHypothesis({
        predicted_winner: 'good',
        predicted_metric: 'ROAS',
        decision_threshold: 2.0,
        kill_condition: 1.0,
      });
      expect(r.valid).toBe(false);
      expect(r.fieldErrors.predicted_winner).toBe('too_short');
    });

    it('rejects unknown metric without --allow-custom-metric', () => {
      const r = validateHypothesis({
        predicted_winner: 'broad audience + UGC',
        predicted_metric: 'flux_capacitor_score',
        decision_threshold: 2.0,
        kill_condition: 1.0,
      });
      expect(r.valid).toBe(false);
      expect(r.fieldErrors.predicted_metric).toBe('unknown_metric');
    });

    it('accepts unknown metric when allowCustomMetric=true', () => {
      const r = validateHypothesis({
        predicted_winner: 'broad audience + UGC',
        predicted_metric: 'flux_capacitor_score',
        decision_threshold: 2.0,
        kill_condition: 1.0,
      }, { allowCustomMetric: true });
      expect(r.valid).toBe(true);
    });

    it('rejects non-finite decision_threshold', () => {
      const r = validateHypothesis({
        predicted_winner: 'broad audience + UGC',
        predicted_metric: 'ROAS',
        decision_threshold: 'two point zero',
        kill_condition: 1.0,
      });
      expect(r.valid).toBe(false);
      expect(r.fieldErrors.decision_threshold).toBe('wrong_type');
    });

    it('accepts both numeric and descriptive kill_condition', () => {
      expect(validateHypothesis({
        predicted_winner: 'broad audience + UGC',
        predicted_metric: 'ROAS',
        decision_threshold: 2.0,
        kill_condition: 0.8,
      }).valid).toBe(true);
      expect(validateHypothesis({
        predicted_winner: 'broad audience + UGC',
        predicted_metric: 'ROAS',
        decision_threshold: 2.0,
        kill_condition: 'spend stays at zero for 5 days',
      }).valid).toBe(true);
    });

    it('rejects entirely non-object input', () => {
      expect(validateHypothesis('hello').valid).toBe(false);
      expect(validateHypothesis(null).valid).toBe(false);
      expect(validateHypothesis(42).valid).toBe(false);
    });
  });

  describe('loadHypothesisFile', () => {
    it('returns ok=false for missing file', () => {
      const r = loadHypothesisFile(join(tmp, 'missing.json'));
      expect(r.ok).toBe(false);
    });

    it('parses bare-object hypothesis file', () => {
      const path = join(tmp, 'h.json');
      writeFileSync(path, JSON.stringify({
        predicted_winner: 'broad audience + UGC',
        predicted_metric: 'ROAS',
        decision_threshold: 2.0,
        kill_condition: 1.0,
      }));
      const r = loadHypothesisFile(path);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.hypothesis.predicted_metric).toBe('ROAS');
    });

    it('parses { hypothesis: ..., note: ... } envelope', () => {
      const path = join(tmp, 'h.json');
      writeFileSync(path, JSON.stringify({
        hypothesis: {
          predicted_winner: 'broad audience + UGC',
          predicted_metric: 'ROAS',
          decision_threshold: 2.0,
          kill_condition: 1.0,
        },
        note: 'first cohort of Q2',
      }));
      const r = loadHypothesisFile(path);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.data.note).toBe('first cohort of Q2');
    });

    it('returns errors for malformed JSON', () => {
      const path = join(tmp, 'h.json');
      writeFileSync(path, '{ not valid json');
      const r = loadHypothesisFile(path);
      expect(r.ok).toBe(false);
    });

    it('returns errors for shape-invalid hypothesis', () => {
      const path = join(tmp, 'h.json');
      writeFileSync(path, JSON.stringify({
        predicted_winner: 'broad audience + UGC',
        predicted_metric: 'ROAS',
        // decision_threshold missing
        kill_condition: 1.0,
      }));
      const r = loadHypothesisFile(path);
      expect(r.ok).toBe(false);
    });
  });
});
