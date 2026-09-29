import { contactImportWorker } from '../queues/processors/contactImport.processor';
import { campaignExecutionWorker } from '../queues/processors/campaignExecution.processor';
import { bulkMessageSendWorker } from '../queues/processors/bulkMessageSend.processor';
import { chatbotDelayWorker } from '../queues/processors/chatbotDelay.processor';
import db from '../../library/surefy/src/database';

const workers = [contactImportWorker, campaignExecutionWorker, bulkMessageSendWorker, chatbotDelayWorker];
console.info('[Workers] Started', { pid: process.pid, workerMode: process.env.WORKER_MODE,
  workers: workers.map(worker => ({ name: worker.name, concurrency: worker.opts.concurrency })) });
let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.info('[Workers] Draining active jobs', { signal, pid: process.pid });
  try {
    await Promise.all(workers.map(worker => worker.close()));
    await db.destroy();
    console.info('[Workers] Shutdown complete');
    process.exit(0);
  } catch (error) {
    console.error('[Workers] Shutdown failed', error);
    process.exit(1);
  }
}
process.once('SIGTERM', () => { void shutdown('SIGTERM'); });
process.once('SIGINT', () => { void shutdown('SIGINT'); });
