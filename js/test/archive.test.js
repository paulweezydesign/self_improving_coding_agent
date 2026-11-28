import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { readFixture, runIteration, selectFromArchive } from '../archive.js';

const raw = [{ question: 'What is two plus two?', answer: '#### 4' }];
const script = { '0': '4' };
const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../cli.js', import.meta.url));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'sica-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return join(root, 'run');
}
const benchDir = (dir, id) => join(dir, `agent_${id}`, 'benchmarks', 'gsm8k');

test('CLI runs, archives raw answers and errors, replays, then selects from disk in a fresh process', async t => {
  const dir = await workspace(t);
  const invoke = async (command, iteration) => JSON.parse((await exec(process.execPath,
    [cli, command, '--archive', dir, '--iteration', String(iteration)])).stdout);
  assert.deepEqual(await invoke('run', 0), { iteration: 0, reused: false, problems: 4,
    perf: { avg_score: 0.5, tokens: 0, num_cached_tokens: 0, cost: 0, time: 0 } });
  const path = benchDir(dir, 0);
  const text = await readFile(join(path, 'results.jsonl'), 'utf8');
  const rows = text.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(rows.map(row => [row.problem_id, row.score]), [['0', 1], ['1', 1], ['2', 0], ['3', 0]]);
  assert.deepEqual(rows[0], { problem_id: '0', timestamp: null, score: 1, tokens_used: 0,
    num_cached_tokens: 0, cost_estimate: 0, wall_time: 0, timed_out: false, cost_threshold_exceeded: false });
  const answers = JSON.parse(await readFile(join(path, 'answers.json'), 'utf8'));
  assert.deepEqual(answers[2], { problem_id: '2', answer: '28', parse_error: null });
  assert.equal(answers[3].answer, '21 dollars');
  assert.ok(answers[3].parse_error);
  assert.equal((await invoke('run', 0)).reused, true);
  assert.equal(await readFile(join(path, 'results.jsonl'), 'utf8'), text);
  await invoke('run', 3);
  assert.deepEqual(await invoke('select', 2), { selected_iteration: 0 });
  assert.deepEqual(await invoke('select', 3), { selected_iteration: 3 });
});

test('invalid inputs never publish and an existing Python run cannot be claimed for writing', async t => {
  const dir = await workspace(t);
  await assert.rejects(runIteration(dir, 0, raw, {}), /exactly one/);
  await assert.rejects(readdir(dir), { code: 'ENOENT' });
  await mkdir(dir);
  await writeFile(join(dir, 'metadata.json'), '{}');
  await assert.rejects(runIteration(dir, 0, raw, script), /new or empty/);
  assert.deepEqual(await readdir(dir), ['metadata.json']);
});

test('concurrent identical runs converge; conflicting scripts cannot replace evidence', async t => {
  const dir = await workspace(t);
  const results = await Promise.all(Array.from({ length: 5 }, () => runIteration(dir, 0, raw, script)));
  assert.equal(results.filter(row => !row.reused).length, 1);
  const attempts = await Promise.allSettled([script, { '0': '5' }].map(s => runIteration(dir, 4, raw, s)));
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
  const conflict = attempts.find(row => row.status === 'rejected');
  assert.match(conflict.reason.message, /different evidence/);
  const [answer] = JSON.parse(await readFile(join(benchDir(dir, 4), 'answers.json'), 'utf8'));
  const perf = JSON.parse(await readFile(join(benchDir(dir, 4), 'perf.json'), 'utf8'));
  assert.equal(perf.avg_score, Number(answer.answer === '4'));
  assert.ok((await readdir(dir)).every(name => !name.startsWith('.sica-stage-')));
});

test('an archive cannot mix fixtures across iterations, even on concurrent first use', async t => {
  const dir = await workspace(t);
  const suites = [raw, [{ ...raw[0], answer: '#### 6' }]];
  const attempts = await Promise.allSettled(suites.map((suite, id) => runIteration(dir, id, suite, script)));
  assert.equal(attempts.filter(row => row.status === 'fulfilled').length, 1);
  const loser = attempts.findIndex(row => row.status === 'rejected');
  assert.match(attempts[loser].reason.message, /different fixture/);
  await assert.rejects(readdir(benchDir(dir, loser)), { code: 'ENOENT' });
});

test('reads Python-shaped archives, skips incomplete pairs and reports malformed evidence', async t => {
  const dir = await workspace(t);
  const partial = benchDir(dir, 5);
  await mkdir(partial, { recursive: true });
  await writeFile(join(partial, 'perf.json'), '{"avg_score":1}');
  const valid = benchDir(dir, 2);
  await mkdir(valid, { recursive: true });
  await writeFile(join(valid, 'perf.json'), '{"avg_score":0.5,"tokens":12,"num_cached_tokens":1,"cost":0.1,"time":2}');
  await writeFile(join(valid, 'results.jsonl'), '{"problem_id":"0","score":1}\n{"problem_id":"1","score":null}\n');
  assert.equal(await selectFromArchive(dir, 6), 2);
  await writeFile(join(partial, 'results.jsonl'), 'bad json\n');
  await assert.rejects(selectFromArchive(dir, 6), /Cannot read GSM8K evidence/);
  assert.equal(await selectFromArchive(dir, 4), 2);
});

test('oversized fixture and noncanonical CLI iteration are rejected', async t => {
  const path = await workspace(t);
  await writeFile(path, Buffer.alloc(1024 * 1024 + 1, ' '));
  await assert.rejects(readFixture(path), /exceeds 1 MiB/);
  for (const iteration of ['-1', '1e3', '2.5', '01', '9007199254740992']) {
    await assert.rejects(exec(process.execPath, [cli, 'run', '--archive', path, '--iteration', iteration]), { code: 1 });
  }
});

test('replays a signed-zero answer key in an initially empty archive', async t => {
  const dir = await workspace(t);
  await mkdir(dir);
  const suite = [{ question: 'Net change?', answer: '#### -0.0' }];
  const zero = { '0': '-0' };
  assert.equal((await runIteration(dir, 0, suite, zero)).perf.avg_score, 1);
  assert.equal((await runIteration(dir, 0, suite, zero)).reused, true);
});

test('selection surfaces damaged published results and retry preserves the evidence', async t => {
  const dir = await workspace(t);
  await runIteration(dir, 0, raw, script);
  const path = join(benchDir(dir, 0), 'results.jsonl');
  await writeFile(path, '');
  await assert.rejects(selectFromArchive(dir, 0), /do not match/);
  await assert.rejects(runIteration(dir, 0, raw, script), /different evidence/);
  assert.equal(await readFile(path, 'utf8'), '');
  await rm(path);
  await assert.rejects(selectFromArchive(dir, 0), /Cannot read GSM8K evidence/);
});
