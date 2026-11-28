import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { readFixture, runIteration, selectFromArchive } from './archive.js';
import { checkIteration } from './selection.js';

const help = `node js/cli.js run --archive DIR --iteration N [--problems FILE] [--responses FILE]
node js/cli.js select --archive DIR --iteration N

DIR is one experiment. N is the iteration to write or the latest eligible base.
The run command defaults to the bundled four-question fixture and response script.`;

async function main([command, ...args]) {
  if (command === '--help') return console.log(help);
  if (!['run', 'select'].includes(command)) throw new Error(help);
  const options = { archive: { type: 'string' }, iteration: { type: 'string' }, help: { type: 'boolean', short: 'h' } };
  if (command === 'run') {
    options.problems = { type: 'string' };
    options.responses = { type: 'string' };
  }
  const { values } = parseArgs({ args, options });
  if (values.help) return console.log(help);
  if (!values.archive || !/^(0|[1-9][0-9]*)$/.test(values.iteration)) throw new Error(help);
  const iteration = Number(values.iteration);
  checkIteration(iteration);
  const runDir = resolve(values.archive);
  if (command === 'select') {
    return console.log(JSON.stringify({ selected_iteration: await selectFromArchive(runDir, iteration) }));
  }
  const [rows, responses] = await Promise.all([
    readFixture(values.problems ?? new URL('./fixtures/problems.json', import.meta.url)),
    readFixture(values.responses ?? new URL('./fixtures/responses.json', import.meta.url)),
  ]);
  const result = await runIteration(runDir, iteration, rows, responses);
  console.log(JSON.stringify(result));
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
