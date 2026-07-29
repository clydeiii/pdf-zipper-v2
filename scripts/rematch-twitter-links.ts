/**
 * Re-run captured-PDF matching for Twitter/X links that are still unmatched.
 *
 * Run:
 *   npx tsx --env-file=.env scripts/rematch-twitter-links.ts
 *   npx tsx --env-file=.env scripts/rematch-twitter-links.ts --dry-run
 */
import { closeTwitterDb, getTwitterDb } from '../src/twitter/db.js';
import { rematchTweetLinks } from '../src/twitter/link-match.js';

function parseArgs(argv: string[]): { dryRun: boolean } {
  let dryRun = false;
  for (const arg of argv) {
    if (arg === '--dry-run') dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { dryRun };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await rematchTweetLinks(getTwitterDb(), {
    dryRun: options.dryRun,
    onMatch: options.dryRun
      ? (row) => {
          console.log(
            `would-match tweet=${row.tweetId} position=${row.position} pdf=${row.pdfPath} url=${row.url}`,
          );
        }
      : undefined,
  });
  console.log(
    `${options.dryRun ? 'Dry-run' : 'Rematch'} summary: checked=${result.checked} matched=${result.matched}`,
  );
}

main()
  .catch((error) => {
    console.error(
      'Twitter link rematch failed:',
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  })
  .finally(() => closeTwitterDb());
