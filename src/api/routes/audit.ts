/**
 * On-demand capture audit endpoint.
 *
 * POST /api/audit/run?hours=24 — re-check every capture modified in the
 * window with the save-path-independent checks in capture-auditor.ts and
 * return the findings as JSON (also posted to Discord). Useful from a phone:
 * the nightly run covers the steady state, this covers "did that batch I
 * just bookmarked come out okay?".
 */

import { Router, Request, Response } from 'express';
import { requireApiToken } from '../auth.js';
import { runCaptureAudit, runAuditWithNotify } from '../../maintenance/capture-auditor.js';
import { coverageDisabledReason, getLatestCoverageReport, runCoverageAudit } from '../../maintenance/coverage-reconciler.js';

export const auditRouter = Router();

auditRouter.post('/coverage', requireApiToken, async (req: Request, res: Response): Promise<void> => {
  const days = req.query.days === undefined ? undefined : Number(req.query.days);
  if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 14)) {
    res.status(400).json({ error: 'days must be an integer from 1 to 14' });
    return;
  }
  const disabled = coverageDisabledReason();
  if (disabled) {
    res.status(503).json({ error: `coverage audit disabled: ${disabled}` });
    return;
  }
  const report = await runCoverageAudit(days);
  if (!report) {
    res.status(503).json({ error: 'coverage audit failed or already running — see logs' });
    return;
  }
  res.json(report);
});

auditRouter.get('/coverage/latest', requireApiToken, async (_req: Request, res: Response): Promise<void> => {
  try {
    const report = await getLatestCoverageReport();
    if (!report) { res.status(404).json({ error: 'No coverage report yet' }); return; }
    res.json(report);
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

auditRouter.post('/run', requireApiToken, async (req: Request, res: Response): Promise<void> => {
  const rawHours = parseInt(String(req.query.hours || ''), 10);
  const hours = Number.isFinite(rawHours) && rawHours > 0 ? Math.min(24 * 14, rawHours) : undefined;
  try {
    // With an explicit window run quietly (JSON response only); the default
    // window also notifies Discord so it matches the nightly behavior.
    const result = hours ? await runCaptureAudit(hours) : await runAuditWithNotify();
    if (!result) {
      res.status(500).json({ error: 'audit failed — see logs' });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});
