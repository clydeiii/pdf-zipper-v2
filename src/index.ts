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
import { startWorker, stopWorker } from './workers/conversion.worker.js';

// Import feed monitoring
import { initializeFeedMonitor, feedQueue, metadataQueue, mediaCollectionQueue } from './feeds/monitor.js';
import { startFeedPollWorker, stopFeedPollWorker } from './feeds/poll-worker.js';
import { startMetadataWorker, stopMetadataWorker } from './feeds/metadata-worker.js';

// Import media collection
import { startMediaWorker, stopMediaWorker } from './media/collection-worker.js';

// Import podcast transcription
import { startPodcastWorker, stopPodcastWorker } from './podcasts/podcast-worker.js';
import { podcastQueue } from './podcasts/podcast.queue.js';

// Import AI self-healing fix system
import { initializeFixScheduler, fixQueue } from './queues/fix.queue.js';
import { startFixWorker, stopFixWorker } from './workers/fix.worker.js';

// Import retention sweeper (auto-deletes data/media weeks older than RETENTION_DAYS)
import { startRetentionSweeper, stopRetentionSweeper } from './maintenance/retention-sweeper.js';

// Import Karakeep cleaner (deletes Karakeep bookmarks older than KARAKEEP_RETENTION_DAYS via its API)
import { startKarakeepCleaner, stopKarakeepCleaner } from './maintenance/karakeep-cleaner.js';
import type { Server } from 'node:http';

console.log(`Environment: ${env.NODE_ENV}`);
console.log(`Server port configured: ${env.PORT}`);

// Log Redis connection status
console.log('Worker connection:', workerConnection.status);
console.log('Queue connection:', queueConnection.status);

// Graceful shutdown handler
let isShuttingDown = false;
let httpServer: Server | null = null;

async function closeHttpServer(): Promise<void> {
  if (!httpServer) return;
  const server = httpServer;
  httpServer = null;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function closeQueuesAndRedis(): Promise<void> {
  await Promise.allSettled([
    conversionQueue.close(),
    feedQueue.close(),
    metadataQueue.close(),
    mediaCollectionQueue.close(),
    podcastQueue.close(),
    fixQueue.close(),
  ]);
  await Promise.allSettled([
    queueConnection.quit(),
    workerConnection.quit(),
  ]);
  console.log('Queues and Redis connections closed');
}

async function gracefulShutdown(signal: string, exitCode = 0): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`${signal} received, shutting down gracefully...`);

  try {
    stopKarakeepCleaner();
    stopRetentionSweeper();

    console.log('Closing HTTP server...');
    await closeHttpServer();
    console.log('HTTP server closed');

    console.log('Closing fix worker...');
    await stopFixWorker();
    console.log('Fix worker closed');

    console.log('Closing podcast worker...');
    await stopPodcastWorker();
    console.log('Podcast worker closed');

    console.log('Closing media worker...');
    await stopMediaWorker();
    console.log('Media worker closed');

    console.log('Closing conversion worker...');
    await stopWorker();
    console.log('Conversion worker closed');

    console.log('Closing feed workers...');
    await stopFeedPollWorker();
    await stopMetadataWorker();
    console.log('Feed workers closed');

    await closeQueuesAndRedis();
  } catch (error) {
    console.error('Error during shutdown:', error);
    exitCode = exitCode || 1;
  }

  process.exit(exitCode);
}

// Start HTTP server and workers
(async () => {
  // Start HTTP server (API + Bull Board)
  httpServer = startServer();

  // Initialize feed monitoring (Job Schedulers for Matter and Karakeep)
  await initializeFeedMonitor();

  // Start feed workers after schedulers are configured
  await startFeedPollWorker();
  await startMetadataWorker();

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

  // Start daily retention sweeper (delete week dirs older than RETENTION_DAYS)
  startRetentionSweeper();

  // Start daily Karakeep cleaner (delete Karakeep bookmarks older than KARAKEEP_RETENTION_DAYS)
  startKarakeepCleaner();

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  console.log('Initialization complete');
  console.log(`Queue '${QUEUE_NAME}' accepting jobs`);
  console.log('Feed monitoring active');
  console.log('Media collection active');
  console.log('Podcast transcription active');
  console.log('AI fix system active');
})().catch((error) => {
  console.error('Startup failed:', error);
  void gracefulShutdown('startup failure', 1);
});
