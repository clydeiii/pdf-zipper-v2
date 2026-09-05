import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runFidelityHarness } from '../quality/fidelity-harness.js';

export async function main(): Promise<void> {
  try {
    const { values } = parseArgs({ options: {
      'only-reviewed': { type: 'boolean', default: false },
      'corpus-dir': { type: 'string' },
    } });
    // pdf-content currently imports Patreon config. These satisfy validation;
    // the harness never opens a Redis connection or starts an application server.
    process.env.REDIS_HOST ??= 'localhost';
    process.env.REDIS_PORT ??= '6379';
    process.env.PORT ??= '3002';
    const result = await runFidelityHarness({ corpusDir: values['corpus-dir'], onlyReviewed: values['only-reviewed'] });
    console.table(result.summary.results.map(({ id, expected, actual, class: kind, reviewed, status }) =>
      ({ id, class: kind, reviewed, expected, actual: actual ?? '-', status })));
    console.log(JSON.stringify({ event: 'fidelity_check', ...result }));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    console.error(JSON.stringify({ event: 'fidelity_check_error', error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
