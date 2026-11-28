# Scripted GSM8K benchmark runner

This is the first Node.js slice of the SICA experiment. It evaluates a fixed set of answers, publishes the evidence for one iteration and selects a base iteration from disk. The included four questions are original GSM8K-style examples. Their scores measure the behavior of the harness. They provide no model-performance estimate.

From the repository root, use Node.js 22 or newer. The Node commands use only built-in modules and need no install, credentials or Docker.

```sh
npm test
npm run benchmark -- --archive ./results/js-demo --iteration 0
npm run select -- --archive ./results/js-demo --iteration 0
```

The default script gets two questions right. Its two misses are a wrong number and an answer with units. The first command that runs the benchmark writes an average of `0.5`. Repeating it returns `reused: true`. Selection returns `{"selected_iteration":0}`.

## Try another candidate

Save the following as `candidate.json` and run a second iteration against the same questions.

```json
{"0":"1200","1":"2.25","2":"29","3":"21"}
```

```sh
npm run benchmark -- --archive ./results/js-demo --iteration 1 --responses candidate.json
npm run select -- --archive ./results/js-demo --iteration 1
```

This script scores `1.0` and selection returns iteration `1`. To supply a local dataset, pass `--problems FILE` with a JSON array of 1–18 GSM8K rows in fixed order, each with a `question` and a worked `answer` ending in `#### <number>`. For a different dataset, use a new archive. IDs are zero-based positions in this local fixture. The response file must supply exactly one string per ID. Each input file is limited to 1 MiB and each text field to 8,192 UTF-16 code units. One invocation evaluates one iteration, with one lookup per question.

## Archive and selection semantics

| Behavior | Implementation |
| --- | --- |
| Numeric scoring | Uses the Python submission hint, removes commas and ASCII spaces, parses decimal and exponent notation, and awards 1 when the absolute error is strictly below `1e-7`. Invalid text scores 0 with a diagnostic. The supported numeric alphabet uses ASCII digits. |
| Result evidence | `agent_N/benchmarks/gsm8k/results.jsonl` has the Python tracker fields. `perf.json` holds mean score and resource totals. `answers.json` retains the verbatim script and parse diagnostics. Scripted time, cost and token usage are zero. The timestamp is null for reproducible output. |
| Publication and replay | `sica-scripted-run/fixture.json` fixes the ordered prompts and answer keys. The runner stages each complete iteration alongside its destination and publishes it with a directory rename on the local filesystem. An identical retry reuses the record. Conflicting evidence for the same iteration is an error. A process killed before publication may leave an ignored `.sica-stage-*` directory. Retry the same inputs. |
| Selection | Reads the GSM8K mean from `perf.json` and sample standard deviation from per-problem scores. The qualifying threshold is the best mean minus `1.96 × sample SD / √n`. It chooses the newest eligible iteration at or above that threshold. The earliest maximum defines the interval in a tie. A single observation gives no sample SD, so the best iteration wins. An empty eligible history returns the reference fallback of 0. |
| Python archives | `select` can read existing GSM8K `perf.json` / `results.jsonl` pairs. A null score contributes zero. Incomplete file pairs are skipped in Python archives. A published scripted iteration with missing or inconsistent result evidence raises an error. Use a fresh directory for scripted writes. |

Two intentional differences from `runner.py` matter for replay. The JavaScript selector uses actual iteration IDs because the reference can mistake a pandas row index for an ID when iteration numbers have gaps. It also excludes future iterations before finding the best score, so a historical selection cannot see later results. The normal interval is reproduced as an engineering selection heuristic. Small scripted fixtures cannot establish statistical superiority.

## Python comparison

With the repository's Python dependencies already installed, the optional comparison uses the reference GSM8K parser and scorer, reconstructs each summary through the Python tracker, and compares the base choice at three successive iterations. It uses a temporary directory and local answer files.

```sh
PYTHONPATH=. python js/check_python_parity.py
```

## Remaining migration work

1. Reproduce the reference dataset revision, split, original IDs and seed-1 sample of 18. Keep the cohort fixed for each PAU-7 comparison.
2. Add a provider execution boundary, per-problem deadlines, metered usage, cost limits and isolated Docker workers. Verify cancellation and cleanup before running live inference.
3. Port in-progress checkpoints, worker recovery, traces and contextual summaries. Validate utility-score selection separately from the default mean-score path, especially zero-cost and timeout cases.
4. Port candidate creation, isolated worktrees or snapshots, review and rollback. Exercise promotion and restart against the archive before enabling a self-modification loop.

Reference code lives in `runner.py`, `base_agent/src/benchmarks/{base,gsm8k}.py` and `base_agent/src/utils/archive_analysis.py`. The upstream MIT license and copyright are in the root `LICENSE`.
