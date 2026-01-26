/**
 * Bull Board monitoring dashboard setup
 *
 * Provides a web UI for inspecting job queue status at /admin/queues
 */

import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { conversionQueue } from '../queues/conversion.queue.js';

/**
 * Express adapter for Bull Board dashboard
 * Mount with: app.use('/admin/queues', serverAdapter.getRouter())
 */
export const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath('/admin/queues');

/**
 * Initialize Bull Board with conversion queue
 */
createBullBoard({
  queues: [new BullMQAdapter(conversionQueue)],
  serverAdapter,
});
