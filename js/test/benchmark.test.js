import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, prepareProblems, scoreAnswer, summarize } from '../benchmark.js';
import { iterationStats, selectBase } from '../selection.js';

const raw = [{ question: ' What is the total? ', answer: 'Working goes here.\n#### 1,200' }];

test('prepares a GSM8K prompt and keeps its answer key out of the statement', () => {
  const [problem] = prepareProblems(raw);
  assert.deepEqual(problem, {
    problem_id: '0',
    statement: 'What is the total?\n\nWhen submitting your answer, please just give a single number with no accompanying text, units or other markings.',
    expected: 1200,
  });
});

test('scores text with the Python decimal cleanup and strict absolute tolerance', () => {
  for (const answer of ['1,200', ' +1 200 ', '12e2', '1200.', '1_200', '1200.00000001']) {
    assert.deepEqual(scoreAnswer(1200, answer), { score: 1, parse_error: null }, answer);
  }
  for (const answer of ['-2', '+inf', 'NaN', '1e500']) {
    assert.deepEqual(scoreAnswer(1200, answer), { score: 0, parse_error: null }, answer);
  }
  for (const answer of ['1,200 labels', '', ' ', '0x0', '1\t2', '1__2', '#### 1200']) {
    assert.equal(scoreAnswer(0, answer).score, 0, answer);
    assert.ok(scoreAnswer(0, answer).parse_error, answer);
  }
  assert.equal(scoreAnswer(0, '0.0000001').score, 0);
  assert.equal(scoreAnswer(0, '-.00000009').score, 1);
});

test('validates the complete suite and script before a run', () => {
  const row = raw[0];
  for (const invalid of [[], Array(19).fill(row), [null], [{ ...row, question: '  ' }],
    ...['', '0x10', '#### NaN', '#### 2 #### 3', '####'].map(answer => [{ ...row, answer }])]) {
    assert.throws(() => prepareProblems(invalid));
  }
  assert.equal(prepareProblems(Array(18).fill(row)).length, 18);
  for (const invalid of [null, [], {}, { '0': '1', '1': '2' }, { missing: '1' },
    { '0': 1200 }, { '0': '1'.repeat(8193) }]) {
    assert.throws(() => evaluate(raw, invalid));
  }
});

test('perf aggregation counts a pending Python score as zero and sums usage', () => {
  const rows = [
    { score: 1, tokens_used: 10, num_cached_tokens: 2, cost_estimate: 0.25, wall_time: 3 },
    { score: null, tokens_used: 5, num_cached_tokens: 1, cost_estimate: 0.5, wall_time: 2 },
  ];
  assert.deepEqual(summarize(rows), { avg_score: 0.5, tokens: 15, num_cached_tokens: 3, cost: 0.75, time: 5 });
});

const stats = (id, scores) => iterationStats(id, summarize(scores.map(score => ({ score }))), scores.map(score => ({ score })));

test('uses the sample standard deviation and a two-sided 95% normal interval', () => {
  const row = stats(0, [1, 1, 1, null]);
  assert.equal(row.mean, 0.75);
  assert.ok(Math.abs(row.lower - 0.26) < 1e-12);
  assert.equal(iterationStats(3, { avg_score: 0.8 }, [{ score: 1 }, { score: 0 }]).mean, 0.8);
  assert.throws(() => iterationStats(1, { avg_score: 0.5 }, [{ score: '1' }]));
});

test('newest qualifying iteration can score below the best, but below-bound and future rows lose', () => {
  const history = [stats(11, [1, 1]), stats(7, [1, 0, 0, 0]), stats(2, [1, 1, 1, 0]), stats(5, [1, 1, 0, 0])];
  assert.equal(selectBase(history, 8), 5);
  assert.equal(selectBase(history, 3), 2);
  assert.equal(selectBase(history, 1), 0);
  assert.equal(selectBase(history, 11), 11);
});

test('equal means, exact threshold, single observation and empty history have defined choices', () => {
  assert.equal(selectBase([stats(2, [1, 1]), stats(8, [1, 1])], 8), 8);
  assert.equal(selectBase([stats(2, [1]), stats(8, [1, 1])], 8), 2);
  assert.equal(selectBase([iterationStats(0, { avg_score: 0 }, [])], 2), 0);
  assert.equal(selectBase([], 0), 0);
  for (const id of [-1, 2.5, 2 ** 53]) assert.throws(() => selectBase([], id));
});
