/**
 * pdf-zipper v2 entry point
 *
 * Startup sequence:
 * 1. Environment validation (fail-fast if missing)
 * 2. Redis connections for BullMQ
 * 3. Conversion queue initialization
 * 4. Browser initialization
 * 5. Feed monitoring initialization
 * 6. HTTP server startup (Express + Bull Board)
 * 7. Worker startup (job processing)
 */

console.log('pdf-zipper v2 starting...');

// Import env first - validates required env vars on load (fail-fast pattern)
import { env } from './config/env.js';

// Import Redis connections - configures connections for BullMQ
import { workerConnection, queueConnection } from './config/redis.js';

// Import and initialize queue
import { conversionQueue, QUEUE_NAME } from './queues/conversion.queue.js';

// Import server and workers
import { startServer } from './api/server.js';
import { startWorker } from './workers/conversion.worker.js';

// Import feed monitoring
import { initializeFeedMonitor } from './feeds/monitor.js';
import { feedPollWorker } from './feeds/poll-worker.js';
import { metadataWorker } from './feeds/metadata-worker.js';

// Import media collection
import { startMediaWorker, stopMediaWorker } from './media/collection-worker.js';

// Import podcast transcription
import { startPodcastWorker, stopPodcastWorker } from './podcasts/podcast-worker.js';

// Import AI self-healing fix system
import { initializeFixScheduler } from './queues/fix.queue.js';
import { startFixWorker, stopFixWorker } from './workers/fix.worker.js';

console.log(`Environment: ${env.NODE_ENV}`);
console.log(`Server port configured: ${env.PORT}`);

// Log Redis connection status
console.log('Worker connection:', workerConnection.status);
console.log('Queue connection:', queueConnection.status);

// Graceful shutdown handler
let isShuttingDown = false;
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received, shutting down gracefully...`);

  try {
    // Close workers in reverse order of startup
    console.log('Closing fix worker...');
    await stopFixWorker();
    console.log('Fix worker closed');

    console.log('Closing podcast worker...');
    await stopPodcastWorker();
    console.log('Podcast worker closed');

    console.log('Closing media worker...');
    await stopMediaWorker();
    console.log('Media worker closed');

    console.log('Closing feed workers...');
    await feedPollWorker.close();
    await metadataWorker.close();
    console.log('Feed workers closed');

    // The conversion worker shutdown is handled by startWorker signal handlers
    // which includes browser cleanup
  } catch (error) {
    console.error('Error during shutdown:', error);
  }
}

// Start HTTP server and workers
(async () => {
  // Start HTTP server (API + Bull Board)
  await startServer();

  // Initialize feed monitoring (Job Schedulers for Matter and Karakeep)
  await initializeFeedMonitor();

  // Start the conversion worker (initializes browser, registers signal handlers)
  await startWorker();

  // Start media collection worker
  await startMediaWorker();
  console.log('Media collection worker initialized');

  // Start podcast transcription worker
  await startPodcastWorker();
  console.log('Podcast transcription worker initialized');

  // Start AI self-healing fix system
  await initializeFixScheduler();
  await startFixWorker();
  console.log('AI fix system initialized');

  // Register additional shutdown handlers for feed workers
  // Note: conversion worker registers its own handlers in startWorker()
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  console.log('Initialization complete');
  console.log(`Queue '${QUEUE_NAME}' accepting jobs`);
  console.log('Feed monitoring active');
  console.log('Media collection active');
  console.log('Podcast transcription active');
  console.log('AI fix system active');
})();
