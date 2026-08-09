/**
 * Commit boundary for AI self-heal batches.
 *
 * Lives apart from fix.worker.ts so tests can import it without dragging in
 * BullMQ and Redis connections, which keep the test process alive forever.
 */

/**
 * True when a batch is allowed to commit this path.
 *
 * Batches land on `fix/batch-*` branches and never auto-merge, so the boundary
 * is about keeping the gate honest and the working tree clean, not about
 * trusting the agent. Anything outside these paths is reverted after the run.
 */
export function isAllowedFixPath(filePath: string): boolean {
  // The gate itself stays out of reach: a batch must not be able to weaken
  // the boundary/build/commit logic that judges it.
  if (filePath === 'src/workers/fix.worker.ts') return false;
  return (
    filePath.startsWith('src/quality/') ||
    filePath.startsWith('src/converters/') ||
    filePath.startsWith('src/workers/') ||
    filePath.startsWith('src/utils/') ||
    filePath.startsWith('src/fix/') ||
    // Tests belong with the fix that motivated them. They were excluded
    // originally, which meant a batch that wrote tests — the good ones nearly
    // always do — had them silently filtered out at commit and left sitting in
    // the working tree, breaking the next person's `npm test` on master. They
    // are not part of the gate (buildGate runs `npm run build`, and the branch
    // is human-reviewed before merge), so there's nothing here to weaken.
    filePath.startsWith('test/')
  );
}
