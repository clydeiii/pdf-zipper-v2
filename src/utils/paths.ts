/**
 * Path safety helpers.
 */

import * as path from 'node:path';

/**
 * Returns true when candidate path resolves within root directory.
 */
export function isPathWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);

  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Resolve a root-relative path and validate containment.
 */
export function resolveWithinRoot(root: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const candidate = path.resolve(resolvedRoot, relativePath);
  if (!isPathWithinRoot(resolvedRoot, candidate) && candidate !== resolvedRoot) {
    return null;
  }
  return candidate;
}

