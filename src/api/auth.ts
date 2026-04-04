/**
 * Optional API token authentication for mutating routes.
 *
 * If API_AUTH_TOKEN is unset, auth is disabled for compatibility.
 */

import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

function extractToken(req: Request): string | null {
  const headerToken = req.header('x-api-token');
  if (headerToken) return headerToken;

  const auth = req.header('authorization');
  if (!auth) return null;
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function requireApiToken(req: Request, res: Response, next: NextFunction): void {
  const expected = env.API_AUTH_TOKEN;

  // Disabled unless explicitly configured
  if (!expected) {
    next();
    return;
  }

  const provided = extractToken(req);
  if (!provided || provided !== expected) {
    res.status(401).json({
      error: 'Unauthorized',
    });
    return;
  }

  next();
}

