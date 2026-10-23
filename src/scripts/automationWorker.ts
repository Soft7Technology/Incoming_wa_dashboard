import 'dotenv/config';
process.env.WORKER_MODE = 'true';
import db from '@surefy/database';
import scheduler from '../app/services/automationRunner.service';
scheduler.start();
console.info('[Automation] Worker started');
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  await scheduler.stop(); await db.destroy(); process.exit(0);
}
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
