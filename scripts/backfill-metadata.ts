/**
 * Backfill enrichment metadata for PDFs that were saved bare (#4).
 *
 * A PDF ends up without Title/Author/Summary/Tags when enrichment failed or
 * lost the manual-capture deadline race at capture time. This sweep finds those
 * files (no EnrichedAt Info Dict field), re-runs the enrichment pipeline from
 * each PDF's own embedded source URL, and re-embeds the result in place.
 *
 * Run (inside the container or with .env loaded so DATA_DIR + OLLAMA_* resolve):
 *   npx tsx --env-file=.env scripts/backfill-metadata.ts            # sweep all weeks
 *   npx tsx --env-file=.env scripts/backfill-metadata.ts --dry-run  # report only
 *   npx tsx --env-file=.env scripts/backfill-metadata.ts --week 2026-W23
 *   npx tsx --env-file=.env scripts/backfill-metadata.ts --limit 5
 *
 * In Docker:
 *   docker exec pdfzipper-v2 npx tsx scripts/backfill-metadata.ts --dry-run
 */
import { backfillBarePdfs } from '../src/metadata/backfill.js';

function parseArgs(argv: string[]): { dryRun: boolean; week?: string; limit?: number } {
  const out: { dryRun: boolean; week?: string; limit?: number } = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--week') out.week = argv[++i];
    else if (arg === '--limit') out.limit = parseInt(argv[++i], 10);
  }
  return out;
}

async function main(): Promise<void> {
  const { dryRun, week, limit } = parseArgs(process.argv.slice(2));
  const result = await backfillBarePdfs({ dryRun, week, limit });
  if (result.failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('backfill failed:', err);
  process.exit(1);
});
