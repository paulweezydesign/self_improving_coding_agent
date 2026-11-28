// Ported from runner.select_base_agent and archive_analysis.compute_statistics (see LICENSE).
export function checkIteration(iteration) {
  if (!Number.isSafeInteger(iteration) || iteration < 0) {
    throw new Error('Iteration must be a nonnegative safe integer');
  }
}

// The current registry runs only GSM8K. perf.json supplies the target mean;
// results.jsonl supplies the sample variance used for its confidence interval.
export function iterationStats(iteration, perf, results) {
  const mean = perf?.avg_score;
  const scores = results.map(row => row.score === null ? 0 : row.score);
  if (![mean, ...scores].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new Error(`Invalid GSM8K score in iteration ${iteration}`);
  }
  if (!scores.length) return null;
  const sampleMean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const squaredDeviations = scores.reduce((sum, score) => sum + (score - sampleMean) ** 2, 0);
  const lower = scores.length === 1 ? null :
    mean - 1.96 * Math.sqrt(squaredDeviations / (scores.length - 1) / scores.length);
  return { iteration, mean, lower };
}

export function selectBase(history, currentIteration) {
  checkIteration(currentIteration);
  const eligible = history.filter(row => row && row.iteration <= currentIteration)
    .sort((a, b) => a.iteration - b.iteration);
  if (!eligible.length) return 0;

  // First maximum in iteration order matches pandas idxmax on contiguous IDs.
  const best = eligible.reduce((a, b) => b.mean > a.mean ? b : a);
  if (best.lower === null) return best.iteration;
  return eligible.findLast(row => row.mean >= best.lower).iteration;
}
