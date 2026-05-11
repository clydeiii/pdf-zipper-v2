/**
 * Express server setup for pdf-zipper v2
 *
 * Features:
 * - REST API for job submission and status (/api/jobs)
 * - REST API for file browsing (/api/files)
 * - REST API for ZIP download (/api/download)
 * - Bull Board monitoring dashboard (/admin/queues)
 * - Static file serving from public/ directory
 * - Health check endpoint (/health)
 */

import express, { Request, Response } from 'express';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { jobsRouter } from './routes/jobs.js';
import { filesRouter } from './routes/files.js';
import { downloadRouter } from './routes/download.js';
import { cookiesRouter } from './routes/cookies.js';
import { debugRouter } from './routes/debug.js';
import { serveRouter } from './routes/serve.js';
import { fixRouter } from './routes/fix.js';
import { telemetryRouter } from './routes/telemetry.js';
import { manualCaptureRouter } from './routes/manual-capture.js';
import { serverAdapter } from './monitoring.js';
import { env } from '../config/env.js';

// ES module dirname workaround
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Express application instance
 */
export const app = express();

// Middleware
// Increase JSON body limit for:
// - cookies.txt uploads (~1-2MB)
// - Chrome plugin manual-capture (base64 PDF + markdown, can reach 20-30MB for long articles)
// Safe to allow large payloads since server is behind Cloudflare Access
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Static file serving from public/ directory
const publicPath = path.join(__dirname, '..', '..', 'public');
app.use(express.static(publicPath));

// Serve Chrome helper plugins for download
const pluginsPath = path.join(__dirname, '..', '..', 'helper-chrome-plugins');
app.use('/plugins', express.static(pluginsPath));

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Mount API routes
app.use('/api/jobs', jobsRouter);
app.use('/api/files', filesRouter);
app.use('/api/download', downloadRouter);
app.use('/api/cookies', cookiesRouter);
app.use('/api/debug', debugRouter);
app.use('/api/fix', fixRouter);
app.use('/api/telemetry', telemetryRouter);
app.use('/api/manual-capture', manualCaptureRouter);
app.use('/api', serveRouter);

// Mount Bull Board dashboard
app.use('/admin/queues', serverAdapter.getRouter());

// Serve index.html at root path (fallback for SPA routing)
app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

/**
 * Start the HTTP server
 */
export function startServer(): void {
  const port = env.PORT;

  app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
    console.log(`Bull Board available at http://localhost:${port}/admin/queues`);
  });
}
