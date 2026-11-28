// Ported from the MIT-licensed SICA benchmarks by Maxime Robeyns (see LICENSE).
const submissionHint = 'When submitting your answer, please just give a single number with no accompanying text, units or other markings.';
const maxProblems = 18;
const maxTextLength = 8192;
const digits = String.raw`[0-9](?:_?[0-9])*`;
const decimal = new RegExp(`^[+-]?(?:${digits}(?:\\.(?:${digits})?)?|\\.${digits})(?:e[+-]?${digits})?$`, 'i');

function boundedText(value, label) {
  if (typeof value !== 'string' || value.length > maxTextLength) {
    throw new Error(`${label} must be a string of at most ${maxTextLength} characters`);
  }
  return value;
}

function parseDecimal(text) {
  // Number() also accepts blanks and hex. GSM8K uses Python float().
  if (decimal.test(text)) return Number(text.replaceAll('_', ''));
  if (/^[+-]?(?:inf(?:inity)?|nan)$/i.test(text)) return NaN;
  return undefined;
}

export function prepareProblems(rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > maxProblems) {
    throw new Error(`Expected 1 to ${maxProblems} GSM8K examples`);
  }
  return rows.map((row, index) => {
    const question = boundedText(row?.question, `question ${index}`).trim();
    const solution = boundedText(row?.answer, `answer key ${index}`);
    const parts = solution.split('####');
    const expected = parts.length === 2 ? parseDecimal(parts[1].trim().replaceAll(',', '')) : undefined;
    if (!question || !Number.isFinite(expected)) {
      throw new Error(`Invalid question or #### numeric answer key at row ${index}`);
    }
    // JSON represents both signed zeros as 0. Use the same key for replays.
    return { problem_id: String(index), statement: question + '\n\n' + submissionHint, expected: expected || 0 };
  });
}

export function scoreAnswer(expected, answer) {
  const value = parseDecimal(answer.trim().replace(/[ ,]/g, ''));
  return {
    score: Math.abs(expected - value) < 1e-7 ? 1 : 0,
    parse_error: value === undefined ? 'Expected a single number' : null,
  };
}

export function summarize(results) {
  const totals = { avg_score: 0, tokens: 0, num_cached_tokens: 0, cost: 0, time: 0 };
  for (const row of results) {
    totals.avg_score += row.score ?? 0;
    totals.tokens += row.tokens_used ?? 0;
    totals.num_cached_tokens += row.num_cached_tokens ?? 0;
    totals.cost += row.cost_estimate ?? 0;
    totals.time += row.wall_time ?? 0;
  }
  if (results.length) totals.avg_score /= results.length;
  return totals;
}

// One lookup per problem. Both inputs are plain data, including the responses.
export function evaluate(rows, responses) {
  const problems = prepareProblems(rows);
  if (!responses || typeof responses !== 'object' || Array.isArray(responses) ||
      Object.keys(responses).length !== problems.length) {
    throw new Error('Supply exactly one scripted response per problem ID');
  }
  const answers = [];
  const results = [];
  for (const { problem_id, expected } of problems) {
    if (!Object.hasOwn(responses, problem_id)) throw new Error(`Missing response for ${problem_id}`);
    const answer = boundedText(responses[problem_id], `response ${problem_id}`);
    const { score, parse_error } = scoreAnswer(expected, answer);
    answers.push({ problem_id, answer, parse_error });
    results.push({
      problem_id, timestamp: null, score, tokens_used: 0, num_cached_tokens: 0,
      cost_estimate: 0, wall_time: 0, timed_out: false, cost_threshold_exceeded: false,
    });
  }
  return { problems, answers, results, perf: summarize(results) };
}
