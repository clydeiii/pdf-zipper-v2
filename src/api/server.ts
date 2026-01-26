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
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // For form submissions

// Static file serving from public/ directory
const publicPath = path.join(__dirname, '..', '..', 'public');
app.use(express.static(publicPath));

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
