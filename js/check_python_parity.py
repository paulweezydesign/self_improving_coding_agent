"""Optional differential check. From the repo root: PYTHONPATH=. python js/check_python_parity.py"""
import asyncio
import json
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

from base_agent.src.benchmarks.base import Problem
from base_agent.src.benchmarks.gsm8k import GSM8KBenchmark, GSM8KExample
from base_agent.src.utils.archive_analysis import ArchiveAnalyzer
from runner import generate_benchmark_statistics, select_base_agent

HERE = Path(__file__).resolve().parent


def cli(command, archive, iteration, *args):
    output = subprocess.check_output(
        ["node", str(HERE / "cli.js"), command, "--archive", str(archive),
         "--iteration", str(iteration), *args], text=True,
    )
    return json.loads(output)


async def compare(root):
    rows = json.loads((HERE / "fixtures/problems.json").read_text())
    examples = [GSM8KExample.from_raw(row) for row in rows]
    # Scoring reads a single answer.txt. The constructor downloads the dataset.
    scorer = GSM8KBenchmark.__new__(GSM8KBenchmark)
    archive = root / "archive"
    scripts = [
        ["1,200", "2.25", "+2.9e1", "21 dollars"],
        ["1 200", "2.25000001", "28", ""],
        ["1_200", "0x2", "NaN", "20"],
    ]
    selected = []
    for iteration, answers in enumerate(scripts):
        script_path = root / "script.json"
        script_path.write_text(json.dumps(dict(enumerate(answers))))
        run = cli("run", archive, iteration, "--responses", script_path)
        agent = archive / f"agent_{iteration}"
        bench = agent / "benchmarks/gsm8k"
        results = [json.loads(line) for line in (bench / "results.jsonl").read_text().splitlines()]
        details = json.loads((bench / "answers.json").read_text())
        fixture = json.loads((archive / "sica-scripted-run/fixture.json").read_text())
        assert len(results) == len(details) == len(fixture["problems"]) == len(examples)
        for i, (example, answer) in enumerate(zip(examples, answers)):
            problem = Problem(str(i), example.question, example.final_answer, "\n".join(example.steps))
            assert fixture["problems"][i] == {
                "problem_id": str(i), "statement": problem.statement, "expected": problem.answer,
            }
            (root / "answer.txt").write_text(answer)
            score, error, _ = await scorer.score_problem(problem, "", str(root), "")
            assert details[i]["answer"] == answer and results[i]["problem_id"] == problem.problem_id
            assert (score, bool(error)) == (results[i]["score"], bool(details[i]["parse_error"]))
        # Rebuild the Node summary using the Python tracker in this disposable run.
        original = json.loads((bench / "perf.json").read_text())
        await generate_benchmark_statistics(agent, "gsm8k")
        assert json.loads((bench / "perf.json").read_text()) == original == run["perf"]
        choice = select_base_agent(ArchiveAnalyzer(archive), iteration)
        assert cli("select", archive, iteration)["selected_iteration"] == choice
        selected.append(int(choice))
    assert selected == [0, 1, 1]
    print(f"Matched {len(examples) * len(scripts)} scores, {len(scripts)} summaries and base choices {selected}")


if __name__ == "__main__":
    with TemporaryDirectory() as workdir:
        asyncio.run(compare(Path(workdir)))
