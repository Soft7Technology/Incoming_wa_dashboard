import 'dotenv/config';

// Also support launching the compiled entry point directly with Node.
// The database must let workers drain their jobs before closing its pool.
process.env.WORKER_MODE = 'true';

import { contactImportWorker } from '../queues/processors/contactImport.processor';
import { campaignExecutionWorker } from '../queues/processors/campaignExecution.processor';
import { bulkMessageSendWorker } from '../queues/processors/bulkMessageSend.processor';
import { chatbotDelayWorker } from '../queues/processors/chatbotDelay.processor';
import { mediaUploadWorker } from '../queues/processors/mediaUpload.processor';
import { closeMediaUploadQueue } from '../queues/mediaUpload.queue';
import { closeContactImportQueue } from '../queues/contactImport.queue';
import db from '../../library/surefy/src/database';
import ReminderScheduler from '../app/services/reminderScheduler.service';
import ShopifyMessageScheduler from '../app/services/shopifyMessageScheduler.service';
import WabaOnboardingScheduler from '../app/services/wabaOnboardingScheduler.service';
import AutomationScheduler from '../app/services/automationRunner.service';
import { redisConnection } from '../../library/surefy/src/config/redis.config';
import { startWorkerHealth } from './health';
import { beginWorkerDrain } from './drain';

ReminderScheduler.start();
ShopifyMessageScheduler.start();
WabaOnboardingScheduler.start();
AutomationScheduler.start();

const workers = [
  contactImportWorker,
  campaignExecutionWorker,
  bulkMessageSendWorker,
  chatbotDelayWorker,
  mediaUploadWorker,
];
console.info('[Workers] Started', {
  pid: process.pid,
  workerMode: process.env.WORKER_MODE,
  databaseCheck: 'Workers consume jobs after their required schema is available',
  workers: workers.map(worker => ({ name: worker.name, concurrency: worker.opts.concurrency })),
});
let stopping = false;
const healthServer = startWorkerHealth(() => !stopping && redisConnection.status === 'ready' &&
  workers.every(worker => worker.isRunning() && !worker.isPaused()));
healthServer.on('error', error => {
  console.error('[Workers] Health server startup failed', { message: error.message });
  process.exit(1);
});
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  beginWorkerDrain();
  console.info('[Workers] Draining active jobs', { signal, pid: process.pid });
  try {
    await Promise.all([ReminderScheduler.stop(), ShopifyMessageScheduler.stop(), WabaOnboardingScheduler.stop(), AutomationScheduler.stop(), ...workers.map(worker => worker.close())]);
    await new Promise<void>(resolve => healthServer.close(() => resolve()));
    await Promise.all([db.destroy(), redisConnection.quit(), closeMediaUploadQueue(), closeContactImportQueue()]);
    console.info('[Workers] Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[Workers] Shutdown failed', error);
    process.exit(1);
  }
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
