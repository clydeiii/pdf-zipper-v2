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
import { runEnrichmentRepair } from '../../maintenance/enrichment-repair.js';
import { runDependencyChecks } from '../../maintenance/dependency-monitor.js';

export const auditRouter = Router();

/**
 * POST /api/audit/repair-enrichment?hours=48&dryRun=1 — run the enrichment
 * repair sweep now (the scheduled one runs every 2h). Returns the backfill
 * result; `skippedReason` is set when Ollama is down or a sweep is already
 * running.
 */
auditRouter.post('/repair-enrichment', requireApiToken, async (req: Request, res: Response): Promise<void> => {
  const rawHours = parseInt(String(req.query.hours || ''), 10);
  const hours = Number.isFinite(rawHours) && rawHours > 0 ? Math.min(24 * 14, rawHours) : undefined;
  const dryRun = ['1', 'true'].includes(String(req.query.dryRun || '').toLowerCase());
  try {
    res.json(await runEnrichmentRepair(hours, dryRun));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/** GET /api/audit/dependencies — probe every external dependency right now. */
auditRouter.get('/dependencies', requireApiToken, async (_req: Request, res: Response): Promise<void> => {
  try {
    res.json({ checkedAt: new Date().toISOString(), dependencies: await runDependencyChecks() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
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
