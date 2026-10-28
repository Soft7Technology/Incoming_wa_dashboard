import 'dotenv/config';
process.env.WORKER_MODE = 'true';
import db from '@surefy/database';
import scheduler from '../app/services/automationRunner.service';
import { actions, queuedStatus } from '../app/utils/automationFlow';
scheduler.start();
console.info('[Automation] Worker started', { queue: queuedStatus(), actions: actions.map(action => `${action.appKey}/${action.key}`) });
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await scheduler.stop(); await db.destroy(); process.exit(0);
}
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
