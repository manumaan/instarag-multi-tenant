import { test } from 'node:test';
import assert from 'node:assert/strict';
import { citedSources, groundVerdict, reconcileTs, scoreReport, type CheckedClaim, type RedFlag } from '../lambda/search/claims';

const claim = (
  verdict: CheckedClaim['verdict'],
  kind: CheckedClaim['kind'] = 'factual',
  basis: CheckedClaim['basis'] = 'web',
): CheckedClaim => ({ text: 'x', kind, basis, verdict, explanation: '', sources: [] });
const flag = (kind = 'inconsistent_numbers'): RedFlag => ({ kind, finding: '', ts_ms: [] });

test('the score is the evidence, less visible deductions for hype and red flags', () => {
  const r = scoreReport(
    [claim('supported'), claim('supported'), claim('partly_supported'), claim('disputed')],
    [{ signal: 'absolute_language', quote: 'always' }, { signal: 'absolute_language', quote: 'never' }],
    [flag()],
  );
  // (1 + 1 + 0.5 + 0) / 4 = 62.5 -> 63; one kind of hype costs 5, one red flag 8.
  assert.equal(r.evidence_score, 63);
  assert.equal(r.base_score, 63);
  assert.equal(r.hype_penalty, 5);
  assert.equal(r.red_flag_penalty, 8);
  assert.equal(r.score, 50);
  assert.equal(r.label, 'mixed');
  assert.equal(r.judged, 4);
});

test('reel-basis, unverifiable, opinion and promotion do not enter the evidence score', () => {
  const r = scoreReport(
    [claim('supported'), claim('unverifiable'), claim('not_checked', 'factual', 'reel'), claim('not_checked', 'opinion'), claim('not_checked', 'promotional')],
    [],
    [],
  );
  assert.equal(r.score, 100);
  assert.equal(r.judged, 1);
  assert.equal(r.label, 'mostly_true');
});

test('with nothing web-checkable, what the reel shows against itself can still make it hype', () => {
  // The "IRL money glitch" shape: claims about the creator's own money, numbers that
  // disagree, no proof, method withheld, and urgency hooks.
  const r = scoreReport(
    [claim('not_checked', 'factual', 'reel')],
    ['urgency_or_scarcity', 'miracle_promise', 'emotional_pressure'].map((signal) => ({ signal, quote: '' })),
    [flag('inconsistent_numbers'), flag('revenue_not_profit'), flag('missing_proof'), flag('withheld_method')],
  );
  // 50 - 15 (three kinds of hype) - 32 (four red flags) = 3.
  assert.equal(r.base_score, 50);
  assert.equal(r.score, 3);
  assert.equal(r.label, 'mostly_hype');
});

test('a reel that claims nothing checkable and shows nothing against itself is "can\'t verify"', () => {
  const r = scoreReport([claim('unverifiable'), claim('not_checked', 'opinion')], [{ signal: 'unsupported_statistic', quote: '16 countries' }], []);
  assert.equal(r.score, null);
  assert.equal(r.label, 'cant_verify');
});

test('deductions are capped: hype at 20, red flags at 40, the score at 0', () => {
  const signals = ['absolute_language', 'urgency_or_scarcity', 'miracle_promise', 'unsupported_statistic', 'emotional_pressure'].map(
    (signal) => ({ signal, quote: '' }),
  );
  const r = scoreReport([claim('supported')], signals, Array.from({ length: 7 }, () => flag()));
  assert.equal(r.hype_penalty, 20);
  assert.equal(r.red_flag_penalty, 40);
  assert.equal(r.score, 40);
  assert.equal(r.label, 'mostly_hype');
});

test('a verdict citing nothing the search returned is downgraded to unverifiable', () => {
  const results = [{ title: 'A', url: 'https://a.example', description: '' }];
  assert.deepEqual(groundVerdict('supported', ['https://made-up.example'], results), { verdict: 'unverifiable', sources: [] });
  assert.deepEqual(groundVerdict('disputed', ['https://a.example', 'https://a.example'], results), {
    verdict: 'disputed',
    sources: [{ title: 'A', url: 'https://a.example' }],
  });
  assert.deepEqual(citedSources(['https://made-up.example'], results), []);
});

test('a timestamp must be one of the moments the model was shown', () => {
  const valid = new Set([0, 2500]);
  assert.equal(reconcileTs(2500, valid), 2500);
  assert.equal(reconcileTs(2400, valid), undefined);
  assert.equal(reconcileTs(null, valid), undefined);
});
