import { isDeepStrictEqual } from 'node:util';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { evaluate, summarize } from './benchmark.js';
import { checkIteration, iterationStats, selectBase } from './selection.js';

const maxInputBytes = 1024 * 1024;

export async function readFixture(path) {
  // end is inclusive, so an oversized input costs at most one extra byte.
  const chunks = [];
  for await (const chunk of createReadStream(path, { end: maxInputBytes })) chunks.push(chunk);
  const data = Buffer.concat(chunks);
  if (data.length > maxInputBytes) throw new Error(`Fixture exceeds 1 MiB: ${path}`);
  return JSON.parse(data.toString('utf8'));
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJSON(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

// A nonempty directory is published by a single rename on the same filesystem.
// Concurrent writers can see only the complete winner. Discard only our own stage.
async function publishDirectory(destination, populate) {
  const parent = dirname(destination);
  const stage = await mkdtemp(join(parent, '.sica-stage-'));
  try {
    await populate(stage);
    try {
      await rename(stage, destination);
      return true;
    } catch (error) {
      if (['EEXIST', 'ENOTEMPTY'].includes(error.code)) return false;
      if (process.platform === 'win32' && error.code === 'EPERM' &&
          (await stat(destination)).isDirectory()) return false;
      throw error;
    }
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

const manifestDir = 'sica-scripted-run';

async function ensureRun(runDir, problems) {
  const manifest = { version: 1, benchmark: 'gsm8k', problems };
  await mkdir(runDir, { recursive: true });
  const names = await readdir(runDir);
  const destination = join(runDir, manifestDir);
  if (!names.includes(manifestDir)) {
    if (names.some(name => !name.startsWith('.sica-stage-'))) {
      throw new Error(`Use a new or empty archive directory: ${runDir}`);
    }
    if (await publishDirectory(destination, stage => writeJSON(join(stage, 'fixture.json'), manifest))) return;
  }
  const stored = await readJSON(join(destination, 'fixture.json'));
  if (!isDeepStrictEqual(stored, manifest)) throw new Error('Archive belongs to a different fixture or version');
}

function benchmarkDir(agentDir) {
  return join(agentDir, 'benchmarks', 'gsm8k');
}

async function readResults(dir) {
  const raw = await readFile(join(dir, 'results.jsonl'), 'utf8');
  return raw.trim() ? raw.trim().split(/\r?\n/).map(line => JSON.parse(line)) : [];
}

export async function runIteration(runDir, iteration, rows, responses) {
  checkIteration(iteration);
  const { problems, answers, results, perf } = evaluate(rows, responses);
  await ensureRun(runDir, problems);
  const agentDir = join(runDir, `agent_${iteration}`);
  const published = await publishDirectory(agentDir, async stage => {
    const dir = benchmarkDir(stage);
    await mkdir(dir, { recursive: true });
    await writeJSON(join(dir, 'answers.json'), answers);
    await writeFile(join(dir, 'results.jsonl'), results.map(row => JSON.stringify(row)).join('\n') + '\n');
    await writeJSON(join(dir, 'perf.json'), perf);
  });
  if (!published) {
    const dir = benchmarkDir(agentDir);
    const stored = await Promise.all([readJSON(join(dir, 'answers.json')), readResults(dir), readJSON(join(dir, 'perf.json'))]);
    if (!isDeepStrictEqual(stored, [answers, results, perf])) {
      throw new Error(`Iteration ${iteration} already contains different evidence`);
    }
  }
  return { iteration, reused: !published, problems: results.length, perf };
}

export async function selectFromArchive(runDir, currentIteration) {
  checkIteration(currentIteration);
  const history = [];
  const entries = await readdir(runDir, { withFileTypes: true });
  const scriptedRun = entries.some(entry => entry.name === manifestDir);
  const fixture = scriptedRun ? await readJSON(join(runDir, manifestDir, 'fixture.json')) : null;
  if (scriptedRun && (fixture?.version !== 1 || !Array.isArray(fixture.problems))) {
    throw new Error('Unrecognized scripted fixture');
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^agent_(0|[1-9][0-9]*)$/.test(entry.name)) continue;
    const iteration = Number(entry.name.slice('agent_'.length));
    if (iteration > currentIteration) continue;
    const dir = benchmarkDir(join(runDir, entry.name));
    try {
      const perf = await readJSON(join(dir, 'perf.json'));
      const results = await readResults(dir);
      if (scriptedRun && (results.length !== fixture.problems.length ||
          results.some((row, i) => row.problem_id !== fixture.problems[i].problem_id || row.score === null) ||
          !isDeepStrictEqual(perf, summarize(results)))) {
        throw new Error('Result rows do not match the fixture or summary');
      }
      history.push(iterationStats(iteration, perf, results));
    } catch (error) {
      // A Python iteration may still be running or may contain other benchmarks.
      if (error.code === 'ENOENT' && !scriptedRun) continue;
      throw new Error(`Cannot read GSM8K evidence in ${dir}: ${error.message}`, { cause: error });
    }
  }
  return selectBase(history, currentIteration);
}
