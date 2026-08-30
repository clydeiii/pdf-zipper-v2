/**
 * One-time seeding after the Substack candidate-key dedup fix (2026-08-30).
 *
 * Pre-fix, every Substack bookmark sits in `bookmarks:seen-urls` under a
 * single spelling (usually the iOS `open.substack.com/pub/…?r=…` form). A
 * later bookmark of the same post from Chrome arrives as the custom-domain
 * spelling, misses that key, and re-captures — the exact dup this fix stops.
 * This script expands every existing Substack entry to its full candidate set
 * (resolved custom domain + static pub form + raw), so the protection also
 * covers the ~2,500 posts captured before the fix.
 *
 * Run on the host:  npx tsx scripts/seed-substack-dedup-keys.ts
 * (Redis is published on localhost:6379; ~466 unique pubs resolve with one
 * HEAD each, cached, small concurrency.)
 */
import { Redis } from 'ioredis';
import { parseSubstackPubPost, substackDedupCandidates } from '../src/urls/substack-canonical.js';

const SEEN_URLS_KEY = 'bookmarks:seen-urls';
const CONCURRENCY = 6;

async function main() {
  const redis = new Redis({ host: process.env.REDIS_HOST || 'localhost', port: 6379 });
  const members = await redis.smembers(SEEN_URLS_KEY);
  const substack = members.filter((m) => parseSubstackPubPost(m) !== null);
  console.log(`${members.length} seen URLs, ${substack.length} Substack post entries`);

  let added = 0;
  let resolveFailures = 0;
  let index = 0;

  async function worker() {
    while (index < substack.length) {
      const url = substack[index++];
      const candidates = await substackDedupCandidates(url);
      if (!candidates) continue;
      // Candidate 1 missing means resolution failed for this pub (static +
      // raw forms are always present) — count it so we know coverage.
      if (candidates.length < 3) resolveFailures++;
      const fresh = [];
      for (const c of candidates) {
        if (!members.includes(c)) fresh.push(c);
      }
      if (fresh.length) {
        added += await redis.sadd(SEEN_URLS_KEY, ...fresh);
      }
      if (index % 250 === 0) console.log(`…${index}/${substack.length} (${added} keys added)`);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`Done: ${added} new dedup keys added; ${resolveFailures} entries missing a resolved candidate`);
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
